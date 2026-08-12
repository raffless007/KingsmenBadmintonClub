import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const INITIAL_PASSCODE = process.env.INITIAL_ADMIN_PASSCODE || "1234";
const SYDNEY = "Australia/Sydney";
const MEDIA_BUCKET = "kingsmen-media";
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

const headers = { "content-type": "application/json; charset=utf-8" };
const reply = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });

function requireConfiguration() {
  if (!SUPABASE_URL || !SERVICE_KEY || !SESSION_SECRET) {
    throw new Error("Server environment variables are not configured.");
  }
}

function storageClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

function eventStartTime(event) {
  return event.court_2_enabled && event.court_2_start_time < event.start_time ? event.court_2_start_time : event.start_time;
}

function eventEndTime(event) {
  return event.court_2_enabled && event.court_2_end_time > event.end_time ? event.court_2_end_time : event.end_time;
}

function totalCourtFee(event) {
  return Number(event.court_fee) + (event.court_2_enabled ? Number(event.court_2_fee || 0) : 0);
}

function eventDurationHours(event) {
  const start = event.start_time.split(":").map(Number);
  const end = event.end_time.split(":").map(Number);
  const startMinutes = start[0] * 60 + start[1];
  const endMinutes = end[0] * 60 + end[1];
  return Math.max((endMinutes - startMinutes) / 60, 0.25);
}

function playerHoursMap(rows, event) {
  const fallback = eventDurationHours(event);
  return new Map((rows || []).map(row => [row.player_id, Number(row.hours_played || fallback)]));
}

function calculatePlayerAmount(event, attendingRows, hoursRows, playerId) {
  const fallback = eventDurationHours(event);
  const hoursByPlayer = playerHoursMap(hoursRows, event);
  const playerIds = attendingRows.map(row => row.player_id);
  const totalHours = playerIds.reduce((sum, id) => sum + (hoursByPlayer.get(id) || fallback), 0);
  if (!totalHours) return 0;
  const playerHours = hoursByPlayer.get(playerId) || fallback;
  const totalCost = totalCourtFee(event) + Number(event.shuttle_fee || 0);
  return Number((totalCost * playerHours / totalHours).toFixed(2));
}

function publicMediaUrl(path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${encoded}`;
}

async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Database request failed (${response.status}) ${path}: ${detail}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function datePartsInSydney(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function dateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nextDateForDay(local, targetDay, nowHour) {
  let delta = (targetDay - local.getUTCDay() + 7) % 7;
  if (delta === 0 && nowHour >= 23) delta = 7;
  return addDays(local, delta);
}

function upcomingBadmintonSessions() {
  const now = datePartsInSydney();
  const local = new Date(Date.UTC(now.year, now.month - 1, now.day));
  const seeds = [nextDateForDay(local, 4, now.hour), nextDateForDay(local, 1, now.hour)];
  const dates = [];
  for (const seed of seeds) {
    for (let index = 0; index < 6; index += 1) {
      dates.push(dateString(addDays(seed, index * 7)));
    }
  }
  return [...new Set(dates)].sort().slice(0, 8);
}

function eventDefaults(eventDate) {
  const day = new Date(`${eventDate}T12:00:00Z`).getUTCDay();
  if (day === 4) {
    return {
      event_date: eventDate,
      location: "Sydney Sports Club",
      suburb: "Kings Park",
      court_1_name: "Court 6",
      court_2_name: "Court 5",
      court_2_enabled: true,
    };
  }
  return {
    event_date: eventDate,
    location: "BadmintonWorx Norwest",
    suburb: "Subject to availability",
    court_1_name: "Court 1",
    court_2_name: "Court 2",
    court_2_enabled: true,
  };
}

async function ensureUpcomingEvents() {
  const events = upcomingBadmintonSessions().map(eventDefaults);
  try {
    await db("events?on_conflict=event_date", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(events),
    });
  } catch (error) {
    if (!String(error.message).includes("court_1_name")) throw error;
    const compatibleEvents = events.map(({ court_1_name, ...event }) => event);
    await db("events?on_conflict=event_date", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(compatibleEvents),
    });
  }
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
}

function localDateTimeToUtc(dateText, timeText, timeZone = SYDNEY) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute, second = 0] = timeText.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
}

function passcodeHash(passcode, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(passcode, salt, 150000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPasscode(passcode, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  const actual = pbkdf2Sync(passcode, salt, 150000, 32, "sha256");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isAdmin(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); }
  catch { return false; }
}

async function getEvent(eventId) {
  const rows = await db(`events?id=eq.${encodeURIComponent(eventId)}&select=*`);
  return rows?.[0];
}

async function getPasscodeSetting() {
  const rows = await db("app_settings?key=eq.admin_passcode_hash&select=value");
  return rows?.[0]?.value || null;
}

async function savePasscode(passcode) {
  await db("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "admin_passcode_hash", value: passcodeHash(passcode), updated_at: new Date().toISOString() }),
  });
}

async function appState() {
  await ensureUpcomingEvents();
  const [players, events, eois, payments, scores, mediaRows] = await Promise.all([
    db("players?select=id,name,active&order=name.asc"),
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,updated_at"),
    db("payments?select=event_id,player_id,amount,paid,paid_at"),
    db("match_scores?select=*&order=created_at.asc"),
    db("media_items?select=*&order=captured_at.desc,created_at.desc"),
  ]);
  const playerHours = await db("event_player_hours?select=event_id,player_id,hours_played,updated_at");
  const media = mediaRows.map(item => ({ ...item, public_url: publicMediaUrl(item.storage_path) }));
  return { players, events, eois, payments, scores, media, playerHours, serverNow: new Date().toISOString() };
}

async function adminState() {
  return { players: await db("players?select=id,name,active&order=name.asc") };
}

async function submitEoi(body) {
  if (!body.playerId || !body.eventId || !["yes", "no"].includes(body.status)) return reply({ error: "Invalid EOI." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const closesAt = new Date(localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone).getTime() - 6 * 60 * 60 * 1000);
  if (new Date() >= closesAt) return reply({ error: "The EOI deadline has passed." }, 409);
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, status: body.status, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function markPaid(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) return reply({ error: "Payments open after the game finishes." }, 409);
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) return reply({ error: "Only players marked In can confirm payment." }, 403);
  const hours = await db(`event_player_hours?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,hours_played`);
  const amount = calculatePlayerAmount(event, attending, hours, body.playerId);
  await db("payments?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, amount, paid: true, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, amount });
}

async function updateShuttleFee(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) {
    return reply({ error: "Shuttle fees can be entered after the session finishes." }, 409);
  }
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) return reply({ error: "Only players from this session can update shuttle fees." }, 403);
  const shuttleFee = Number(body.shuttleFee);
  if (!Number.isFinite(shuttleFee) || shuttleFee < 0 || shuttleFee > 1000) return reply({ error: "Enter a valid shuttle fee." }, 400);
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ shuttle_fee: shuttleFee, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

function validBadmintonScore(pointsA, pointsB) {
  if (![pointsA, pointsB].every(value => Number.isInteger(value) && value >= 0 && value <= 30)) return { valid: false };
  if (pointsA === pointsB) return { valid: false };
  const winner = Math.max(pointsA, pointsB);
  const loser = Math.min(pointsA, pointsB);
  const valid = winner === 30 ? loser <= 29 : winner >= 21 && winner <= 29 && winner - loser >= 2;
  return { valid };
}

export { validBadmintonScore };

async function submitScore(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.submittedBy) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone)) {
    return reply({ error: "Scores can be added after the session starts." }, 409);
  }
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (!attending.has(body.submittedBy)) return reply({ error: "Only players marked In can enter scores." }, 403);
  const matches = Array.isArray(body.matches) ? body.matches : [body];
  if (!matches.length) return reply({ error: "Add at least one match." }, 400);
  const inserts = [];
  for (const match of matches) {
    const teamA = Array.isArray(match.teamA) ? match.teamA.filter(Boolean) : [];
    const teamB = Array.isArray(match.teamB) ? match.teamB.filter(Boolean) : [];
    const allPlayers = [...teamA, ...teamB];
    if (teamA.length !== 2 || teamB.length !== 2) return reply({ error: "Every doubles match requires exactly two players on each team." }, 400);
    if (new Set(allPlayers).size !== 4 || allPlayers.some(id => !attending.has(id))) {
      return reply({ error: "Each match must contain four different players from the final In list." }, 400);
    }
    const gamesA = Number(match.gamesA), gamesB = Number(match.gamesB);
    const checked = validBadmintonScore(gamesA, gamesB);
    if (!checked.valid) return reply({ error: "Enter a valid badminton score: first to 21, win by 2, capped at 30." }, 400);
    inserts.push({
      event_id: body.eventId,
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      games_a: gamesA,
      games_b: gamesB,
      tiebreak_a: null,
      tiebreak_b: null,
      submitted_by: body.submittedBy,
    });
  }
  await db("match_scores", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(inserts),
  });
  return reply({ ok: true, saved: inserts.length });
}

async function adminLogin(body) {
  if (!/^\d{4,8}$/.test(body.passcode || "")) return reply({ error: "Invalid passcode." }, 401);
  let stored = await getPasscodeSetting();
  if (!stored && body.passcode === INITIAL_PASSCODE) {
    await savePasscode(body.passcode);
    stored = await getPasscodeSetting();
  }
  if (!verifyPasscode(body.passcode, stored)) return reply({ error: "Incorrect passcode." }, 401);
  return reply({ ok: true, token: signSession() });
}

async function changePasscode(body) {
  const stored = await getPasscodeSetting();
  if (!verifyPasscode(body.currentPasscode || "", stored)) return reply({ error: "Current passcode is incorrect." }, 401);
  if (!/^\d{4,8}$/.test(body.newPasscode || "")) return reply({ error: "Use 4–8 numbers." }, 400);
  await savePasscode(body.newPasscode);
  return reply({ ok: true, token: signSession() });
}

async function saveEvent(body) {
  const allowed = ["event_date", "start_time", "end_time", "location", "suburb", "court_1_name", "court_fee", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_2_fee", "shuttle_fee", "account_closed"];
  const update = Object.fromEntries(Object.entries(body.changes || {}).filter(([key]) => allowed.includes(key)));
  update.updated_at = new Date().toISOString();
  try {
    await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
    });
  } catch (error) {
    if (!String(error.message).includes("court_1_name")) throw error;
    const { court_1_name, ...compatibleUpdate } = update;
    await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(compatibleUpdate),
    });
  }
  return reply({ ok: true });
}

async function deleteEvent(body) {
  if (!body.eventId) return reply({ error: "Event not found." }, 404);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  if (new Date() >= localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone)) {
    return reply({ error: "Only upcoming events can be deleted from this screen." }, 409);
  }
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function addPlayer(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 80) return reply({ error: "Enter a valid player name." }, 400);
  await db("players?on_conflict=name", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ name, active: true }),
  });
  return reply({ ok: true });
}

async function removePlayer(body) {
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
  return reply({ ok: true });
}

async function adminSetEoi(body) {
  if (!body.eventId || !body.playerId || !["yes", "no", "none"].includes(body.status)) {
    return reply({ error: "Choose a valid player and EOI status." }, 400);
  }
  if (body.status === "none") {
    await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return reply({ ok: true });
  }
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      status: body.status,
      updated_at: new Date().toISOString(),
    }),
  });
  if (body.status === "no") {
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  }
  return reply({ ok: true });
}

async function adminSetPayment(body) {
  if (!body.eventId || !body.playerId || typeof body.paid !== "boolean") {
    return reply({ error: "Choose a valid payment status." }, 400);
  }
  if (!body.paid) {
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return reply({ ok: true });
  }
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) {
    return reply({ error: "Only players marked In can have a payment recorded." }, 409);
  }
  const hours = await db(`event_player_hours?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,hours_played`);
  const amount = calculatePlayerAmount(event, attending, hours, body.playerId);
  await db("payments?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      amount,
      paid: true,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return reply({ ok: true });
}

async function adminSetPlayerHours(body) {
  if (!body.eventId || !body.playerId) return reply({ error: "Choose a valid event and player." }, 400);
  const hours = Number(body.hoursPlayed);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8) return reply({ error: "Enter hours between 0 and 8." }, 400);
  await db("event_player_hours?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      hours_played: hours,
      updated_at: new Date().toISOString(),
    }),
  });
  await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function adminDeleteScore(body) {
  if (!body.scoreId) return reply({ error: "Score not found." }, 404);
  await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function createMediaUpload(body) {
  const originalName = String(body.fileName || "").trim();
  const mimeType = String(body.mimeType || "").toLowerCase();
  const fileSize = Number(body.fileSize);
  if (!body.playerId || !originalName || !/^(image|video)\//.test(mimeType)) {
    return reply({ error: "Choose an image or video to upload." }, 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MEDIA_MAX_BYTES) {
    return reply({ error: "Media files must be 200 MB or smaller." }, 400);
  }
  const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id`);
  if (!players.length) return reply({ error: "Select an active player before uploading." }, 403);
  const extensionMatch = originalName.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  const extension = extensionMatch ? `.${extensionMatch[1]}` : "";
  const now = datePartsInSydney();
  const folder = `${now.year}/${String(now.month).padStart(2, "0")}`;
  const path = `${folder}/${randomUUID()}${extension}`;
  const { data, error } = await storageClient().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) throw error || new Error("Could not create the upload URL.");
  return reply({ ok: true, path, signedUrl: data.signedUrl });
}

async function finalizeMediaUpload(body) {
  const title = String(body.title || "").trim();
  const path = String(body.path || "");
  const originalName = String(body.originalName || "").trim();
  const mimeType = String(body.mimeType || "").toLowerCase();
  const capturedAt = String(body.capturedAt || "");
  if (!body.playerId || title.length < 1 || title.length > 120 || !/^\d{4}\/\d{2}\/[a-f0-9-]+(?:\.[a-z0-9]{1,10})?$/.test(path)) {
    return reply({ error: "Complete the media title and upload details." }, 400);
  }
  if (!/^(image|video)\//.test(mimeType) || !/^\d{4}-\d{2}-\d{2}$/.test(capturedAt)) {
    return reply({ error: "Invalid media type or date." }, 400);
  }
  const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id`);
  if (!players.length) return reply({ error: "Select an active player before uploading." }, 403);
  const segments = path.split("/");
  const fileName = segments.pop();
  const folder = segments.join("/");
  const { data: stored, error } = await storageClient().storage.from(MEDIA_BUCKET).list(folder, { search: fileName, limit: 10 });
  if (error || !stored?.some(item => item.name === fileName)) {
    return reply({ error: "The uploaded file could not be verified." }, 409);
  }
  await db("media_items", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      player_id: body.playerId,
      title,
      media_type: mimeType.startsWith("image/") ? "image" : "video",
      storage_path: path,
      original_name: originalName.slice(0, 255),
      mime_type: mimeType,
      captured_at: capturedAt,
    }),
  });
  return reply({ ok: true });
}

async function adminDeleteMedia(body) {
  const rows = await db(`media_items?id=eq.${encodeURIComponent(body.mediaId || "")}&select=id,storage_path`);
  const item = rows?.[0];
  if (!item) return reply({ error: "Media item not found." }, 404);
  const { error } = await storageClient().storage.from(MEDIA_BUCKET).remove([item.storage_path]);
  if (error) throw error;
  await db(`media_items?id=eq.${encodeURIComponent(item.id)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function updatePlayer(body) {
  const update = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (!body.playerId || !Object.keys(update).length) return reply({ error: "Nothing to update." }, 400);
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
  });
  return reply({ ok: true });
}

export default async (req) => {
  try {
    requireConfiguration();
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));

    if (req.method === "GET" && action === "state") return reply(await appState());
    if (req.method === "POST" && action === "eoi") return submitEoi(body);
    if (req.method === "POST" && action === "paid") return markPaid(body);
    if (req.method === "POST" && action === "shuttle-fee") return updateShuttleFee(body);
    if (req.method === "POST" && action === "score") return submitScore(body);
    if (req.method === "POST" && action === "media-upload-url") return createMediaUpload(body);
    if (req.method === "POST" && action === "media-finalize") return finalizeMediaUpload(body);
    if (req.method === "POST" && action === "admin-login") return adminLogin(body);
    if (req.method === "GET" && action === "admin-state") {
      if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
      return reply(await adminState());
    }

    if (!["admin-change-passcode", "admin-save-event", "admin-delete-event", "admin-add-player", "admin-update-player", "admin-remove-player", "admin-set-eoi", "admin-set-payment", "admin-set-hours", "admin-delete-score", "admin-delete-media"].includes(action)) {
      return reply({ error: "Unknown action." }, 404);
    }
    if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
    if (action === "admin-change-passcode") return changePasscode(body);
    if (action === "admin-save-event") return saveEvent(body);
    if (action === "admin-delete-event") return deleteEvent(body);
    if (action === "admin-add-player") return addPlayer(body);
    if (action === "admin-update-player") return updatePlayer(body);
    if (action === "admin-remove-player") return removePlayer(body);
    if (action === "admin-set-eoi") return adminSetEoi(body);
    if (action === "admin-set-payment") return adminSetPayment(body);
    if (action === "admin-set-hours") return adminSetPlayerHours(body);
    if (action === "admin-delete-score") return adminDeleteScore(body);
    if (action === "admin-delete-media") return adminDeleteMedia(body);
  } catch (error) {
    console.error(error);
    if (error.message === "Server environment variables are not configured.") {
      return reply({ error: "Netlify environment variables are not configured. Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ADMIN_SESSION_SECRET, then redeploy." }, 500);
    }
    if (error.message?.startsWith("Database request failed")) {
      return reply({
        error: "Supabase request failed.",
        detail: error.message,
        next: "Use the detail field to identify whether this is a missing table, wrong key, RLS/permission issue, or SQL schema problem.",
      }, 500);
    }
    return reply({ error: "The server could not complete that request." }, 500);
  }
};

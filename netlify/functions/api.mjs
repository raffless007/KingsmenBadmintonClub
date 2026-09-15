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
  return [event.start_time, event.court_2_enabled ? event.court_2_start_time : null, event.court_3_enabled ? event.court_3_start_time : null]
    .filter(Boolean)
    .sort()[0];
}

function eventEndTime(event) {
  return [event.end_time, event.court_2_enabled ? event.court_2_end_time : null, event.court_3_enabled ? event.court_3_end_time : null]
    .filter(Boolean)
    .sort()
    .at(-1);
}

function isThursdayEvent(event) {
  return new Date(`${event.event_date}T12:00:00Z`).getUTCDay() === 4;
}

function eventCapacity(event) {
  return event.court_3_enabled ? 14 : 12;
}

function shiftLocalDate(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateString(date);
}

function thursdayLockAt(event) {
  return localDateTimeToUtc(shiftLocalDate(event.event_date, -2), "20:00:00", event.timezone);
}

function thursdayLateEoiCloseAt(event) {
  return localDateTimeToUtc(event.event_date, "12:00:00", event.timezone);
}

function thursdayScheduleAt(event) {
  return localDateTimeToUtc(event.event_date, "12:01:00", event.timezone);
}

function oldEoiDeadline(event) {
  return localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone).getTime() - 6 * 60 * 60 * 1000;
}

function totalCourtFee(event) {
  return Number(event.court_fee) + (event.court_2_enabled ? Number(event.court_2_fee || 0) : 0) + (event.court_3_enabled ? Number(event.court_3_fee || 0) : 0);
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
      court_1_name: "Court 1",
      court_2_name: "Court 2",
      court_2_enabled: true,
      court_3_enabled: false,
      court_3_name: "Court 3",
      court_3_start_time: "22:00",
      court_3_end_time: "23:00",
    };
  }
  return {
    event_date: eventDate,
    location: "BadmintonWorx Norwest",
    suburb: "Subject to availability",
    court_1_name: "Court 1",
    court_2_name: "Court 2",
    court_2_enabled: true,
    court_3_enabled: false,
    court_3_name: "Court 3",
    court_3_start_time: "22:00",
    court_3_end_time: "23:00",
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

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const minutes = Math.max(0, value);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
}

function combinations(items, size) {
  const result = [];
  function walk(start, picked) {
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index <= items.length - (size - picked.length); index += 1) {
      picked.push(items[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  }
  walk(0, []);
  return result;
}

function pairKey(a, b) {
  return [a, b].sort().join(":");
}

function pairingCandidates(players) {
  const result = [];
  for (const four of combinations(players, 4)) {
    const [a, b, c, d] = four;
    result.push({ teamA: [a, b], teamB: [c, d] });
    result.push({ teamA: [a, c], teamB: [b, d] });
    result.push({ teamA: [a, d], teamB: [b, c] });
  }
  return result;
}

function recordPairingStats(pairing, stats, round) {
  const all = [...pairing.teamA, ...pairing.teamB];
  for (const player of all) {
    const row = stats.get(player.id);
    if (!row) continue;
    row.played += 1;
    row.lastPlayed = round;
  }
  for (const team of [pairing.teamA, pairing.teamB]) {
    const [a, b] = team;
    if (!stats.has(a.id) || !stats.has(b.id)) continue;
    stats.get(a.id).teammates.set(b.id, (stats.get(a.id).teammates.get(b.id) || 0) + 1);
    stats.get(b.id).teammates.set(a.id, (stats.get(b.id).teammates.get(a.id) || 0) + 1);
  }
  for (const a of pairing.teamA) {
    for (const b of pairing.teamB) {
      if (!stats.has(a.id) || !stats.has(b.id)) continue;
      stats.get(a.id).opponents.set(b.id, (stats.get(a.id).opponents.get(b.id) || 0) + 1);
      stats.get(b.id).opponents.set(a.id, (stats.get(b.id).opponents.get(a.id) || 0) + 1);
    }
  }
}

function choosePairing(players, used, stats, round) {
  const available = players.filter(player => !used.has(player.id));
  if (available.length < 4) return null;
  let best = null;
  for (const candidate of pairingCandidates(available)) {
    const groups = [candidate.teamA, candidate.teamB];
    const all = groups.flat();
    let score = 0;
    for (const player of all) {
      const row = stats.get(player.id);
      const gap = row.lastPlayed < 0 ? round + 1 : round - row.lastPlayed;
      score += row.played * 14 - gap * 4;
    }
    score += (stats.get(candidate.teamA[0].id).teammates.get(candidate.teamA[1].id) || 0) * 30;
    score += (stats.get(candidate.teamB[0].id).teammates.get(candidate.teamB[1].id) || 0) * 30;
    for (const playerA of candidate.teamA) {
      for (const playerB of candidate.teamB) {
        score += (stats.get(playerA.id).opponents.get(playerB.id) || 0) * 7;
      }
    }
    if (!best || score < best.score) best = { ...candidate, score };
  }
  if (!best) return null;
  recordPairingStats(best, stats, round);
  return best;
}

function scheduleSlots(event) {
  const baseStart = timeToMinutes(event.start_time) + 10;
  const end = timeToMinutes(eventEndTime(event));
  const courts = [
    { name: event.court_1_name || "Court 1", start: baseStart, end: timeToMinutes(event.end_time) },
    ...(event.court_2_enabled ? [{ name: event.court_2_name || "Court 2", start: Math.max(baseStart, timeToMinutes(event.court_2_start_time)), end: timeToMinutes(event.court_2_end_time) }] : []),
    ...(event.court_3_enabled ? [{ name: event.court_3_name || "Court 3", start: Math.max(timeToMinutes(event.court_3_start_time || "22:00"), baseStart), end: timeToMinutes(event.court_3_end_time || event.end_time) }] : []),
  ];
  const slots = new Map();
  for (const court of courts) {
    for (let start = court.start; start + 12 <= Math.min(court.end, end); start += 13) {
      const list = slots.get(start) || [];
      list.push({ ...court, start, end: start + 12 });
      slots.set(start, list);
    }
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]);
}

async function lockDueThursdayEois(event) {
  if (!isThursdayEvent(event) || new Date() < thursdayLockAt(event)) return;
  const rows = await db(`eois?event_id=eq.${encodeURIComponent(event.id)}&status=eq.yes&locked_in=eq.false&select=player_id`);
  await Promise.all(rows.map(row => db(`eois?event_id=eq.${encodeURIComponent(event.id)}&player_id=eq.${encodeURIComponent(row.player_id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ locked_in: true, locked_at: thursdayLockAt(event).toISOString(), updated_at: new Date().toISOString() }),
  })));
}

function pairingKey(players) {
  return [...players].sort().join(":");
}

function derivePairingsFromScores(scores, count) {
  const pairings = [];
  const seen = new Set();
  for (const row of [...scores].sort((a, b) => (a.match_number || 9999) - (b.match_number || 9999))) {
    for (const pair of [row.team_a_player_ids, row.team_b_player_ids]) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const key = pairingKey(pair);
      if (seen.has(key)) continue;
      seen.add(key);
      pairings.push([...pair]);
      if (pairings.length >= Math.ceil(count / 2)) return pairings;
    }
  }
  return pairings;
}

async function getEventPairings(eventId, players, scores = []) {
  const key = `pairings:${eventId}`;
  const rows = await db(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  const saved = rows?.[0]?.value ? JSON.parse(rows[0].value) : null;
  const attending = new Set(players.map(player => player.id));
  if (Array.isArray(saved) && saved.length && saved.every(pair => Array.isArray(pair) && pair.length === 2 && new Set(pair).size === 2 && pair.every(id => attending.has(id)))) {
    return saved;
  }
  const derived = derivePairingsFromScores(scores, players.length);
  const fallback = derived.length === Math.ceil(players.length / 2)
    ? derived
    : players.reduce((result, player, index) => index % 2 ? result : [...result, players.slice(index, index + 2).map(item => item.id)], []);
  return fallback;
}

async function saveEventPairings(eventId, pairings) {
  await db("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: `pairings:${eventId}`, value: JSON.stringify(pairings), updated_at: new Date().toISOString() }),
  });
}

function chooseFixedPairing(pairings, used, stats, round) {
  const available = pairings.filter(pair => pair.every(id => !used.has(id))).map(pair => pair.map(id => ({ id })));
  if (available.length < 2) return null;
  let best = null;
  for (let i = 0; i < available.length - 1; i += 1) {
    for (let j = i + 1; j < available.length; j += 1) {
      const teamA = available[i];
      const teamB = available[j];
      const all = [...teamA, ...teamB];
      let score = 0;
      for (const player of all) {
        const row = stats.get(player.id);
        if (!row) continue;
        const gap = row.lastPlayed < 0 ? round + 1 : round - row.lastPlayed;
        score += row.played * 14 - gap * 4;
      }
      for (const playerA of teamA) for (const playerB of teamB) {
        score += (stats.get(playerA.id)?.opponents.get(playerB.id) || 0) * 7;
      }
      if (!best || score < best.score) best = { teamA, teamB, score };
    }
  }
  if (!best) return null;
  recordPairingStats(best, stats, round);
  return best;
}

async function generateEventSchedule(eventId, { force = true } = {}) {
  const event = await getEvent(eventId);
  if (!event) throw new Error("Event not found.");
  if (isThursdayEvent(event) && !force && new Date() < thursdayScheduleAt(event)) {
    return { saved: 0, message: "Thursday schedules open at 12:01 PM." };
  }
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  const players = attendingRows.map(row => ({ id: row.player_id }));
  if (players.length < 4) return { saved: 0, message: "At least four players must be marked In before generating a schedule." };

  const existing = await db(`match_scores?event_id=eq.${encodeURIComponent(eventId)}&select=*&order=match_number.asc`);
  const fixedPairings = await getEventPairings(eventId, players, existing);
  await saveEventPairings(eventId, fixedPairings);
  const protectedRows = existing.filter(row => row.status === "live" || row.pairing_manual || row.schedule_manual);
  const replaceable = existing.filter(row => row.status !== "completed" && !protectedRows.some(item => item.id === row.id));
  await Promise.all(replaceable.map(row => db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })));

  const protectedBySlot = new Map(protectedRows.map(row => [`${row.scheduled_start}|${row.court_name}`, row]));
  const stats = new Map(players.map(player => [player.id, { played: 0, lastPlayed: -1, teammates: new Map(), opponents: new Map() }]));
  for (const row of protectedRows) {
    recordPairingStats({ teamA: (row.team_a_player_ids || []).map(id => ({ id })), teamB: (row.team_b_player_ids || []).map(id => ({ id })) }, stats, 0);
  }
  const rows = [];
  let round = 0;
  const usedMatchNumbers = new Set(protectedRows.map(row => Number(row.match_number)).filter(Boolean));
  let matchNumber = 1;
  const allocateMatchNumber = () => { while (usedMatchNumbers.has(matchNumber)) matchNumber += 1; usedMatchNumbers.add(matchNumber); return matchNumber++; };
  for (const [start, roundCourts] of scheduleSlots(event)) {
    const used = new Set();
    for (const court of roundCourts) {
      const key = `${minutesToTime(start)}|${court.name}`;
      const protectedRow = protectedBySlot.get(key);
      if (protectedRow) {
        for (const playerId of [...(protectedRow.team_a_player_ids || []), ...(protectedRow.team_b_player_ids || [])]) used.add(playerId);
        continue;
      }
      const pairing = chooseFixedPairing(fixedPairings, used, stats, round) || choosePairing(players, used, stats, round);
      if (!pairing) continue;
      [...pairing.teamA, ...pairing.teamB].forEach(player => used.add(player.id));
      rows.push({
        event_id: eventId,
        match_number: allocateMatchNumber(),
        court_name: court.name,
        scheduled_start: minutesToTime(start),
        scheduled_end: minutesToTime(court.end),
        team_a_player_ids: pairing.teamA.map(player => player.id),
        team_b_player_ids: pairing.teamB.map(player => player.id),
        games_a: 0,
        games_b: 0,
        target_points: 21,
        best_of: 1,
        status: "scheduled",
        current_game: 1,
        points_a: 0,
        points_b: 0,
        game_scores: [],
        score_history: [],
      });
    }
    round += 1;
  }
  if (rows.length) {
    await db("match_scores", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
  }
  await db(`events?id=eq.${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ schedule_generated_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return { saved: rows.length };
}

async function maybeGenerateEventSchedule(eventId) {
  const event = await getEvent(eventId);
  if (!event) return;
  if (isThursdayEvent(event)) {
    if (new Date() < thursdayScheduleAt(event)) return;
    if (event.schedule_generated_at) return;
    await generateEventSchedule(eventId, { force: false });
    return;
  }
  const existing = await db(`match_scores?event_id=eq.${encodeURIComponent(eventId)}&select=id&limit=1`);
  if (existing.length) return;
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  if (attending.length >= 4) await generateEventSchedule(eventId);
}

async function maintainThursdaySessions() {
  const events = await db("events?select=*&order=event_date.asc");
  for (const event of events) {
    await lockDueThursdayEois(event);
    if (isThursdayEvent(event) && new Date() >= thursdayScheduleAt(event) && !event.schedule_generated_at) {
      await maybeGenerateEventSchedule(event.id);
    }
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
  await maintainThursdaySessions();
  const [players, events, eois, payments, scores, mediaRows] = await Promise.all([
    db("players?select=id,name,active&order=name.asc"),
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,locked_in,locked_at,penalty_amount,updated_at"),
    db("payments?select=event_id,player_id,amount,paid,paid_at"),
    db("match_scores?select=*&order=created_at.asc"),
    db("media_items?select=*&order=captured_at.desc,created_at.desc"),
  ]);
  const playerHours = await db("event_player_hours?select=event_id,player_id,hours_played,updated_at");
  const media = mediaRows.map(item => ({ ...item, public_url: publicMediaUrl(item.storage_path) }));
  const eventPairings = Object.fromEntries(await Promise.all(events.map(async event => {
    const rows = await db(`app_settings?key=eq.${encodeURIComponent(`pairings:${event.id}`)}&select=value`);
    const value = rows?.[0]?.value;
    try { return [event.id, value ? JSON.parse(value) : null]; } catch { return [event.id, null]; }
  })));
  return { players, events, eois, payments, scores, media, playerHours, eventPairings, serverNow: new Date().toISOString() };
}

async function adminState() {
  return { players: await db("players?select=id,name,active&order=name.asc") };
}

async function submitEoi(body) {
  if (!body.playerId || !body.eventId || !["yes", "no"].includes(body.status)) return reply({ error: "Invalid EOI." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const now = new Date();
  if (isThursdayEvent(event)) {
    await lockDueThursdayEois(event);
    const rows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,status,locked_in`);
    const current = rows.find(row => row.player_id === body.playerId);
    const yesCount = rows.filter(row => row.status === "yes").length;
    const capacity = eventCapacity(event);
    if (current?.status === "yes" && (current.locked_in || now >= thursdayLockAt(event))) {
      return reply({ error: "Thursday players are locked after Tuesday 8:00 PM. Ask Admin to change this EOI." }, 409);
    }
    if (current?.status === "no" && now >= thursdayLockAt(event)) {
      return reply({ error: "EOIs submitted by Tuesday 8:00 PM cannot be changed after the deadline." }, 409);
    }
    if (!current && now >= thursdayLateEoiCloseAt(event)) {
      return reply({ error: "New Thursday EOIs close at 12:00 PM on Thursday." }, 409);
    }
    if (body.status === "yes" && current?.status !== "yes" && yesCount >= capacity) {
      return reply({ error: `This session is full at ${capacity} players. Ask Admin if a place becomes available.` }, 409);
    }
  } else if (now.getTime() >= oldEoiDeadline(event)) {
    return reply({ error: "The EOI deadline has passed." }, 409);
  }
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, status: body.status, updated_at: new Date().toISOString() }),
  });
  await maybeGenerateEventSchedule(body.eventId);
  return reply({ ok: true });
}

async function markPaid(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) return reply({ error: "Payments open after the game finishes." }, 409);
  const eoiRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,status,penalty_amount`);
  const eoi = eoiRows.find(row => row.player_id === body.playerId);
  const attending = eoiRows.filter(row => row.status === "yes");
  if (!eoi || (eoi.status !== "yes" && Number(eoi.penalty_amount || 0) <= 0)) return reply({ error: "Only players with a session payment or late cancellation penalty can confirm payment." }, 403);
  const hours = await db(`event_player_hours?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,hours_played`);
  const amount = eoi.status === "yes" ? calculatePlayerAmount(event, attending, hours, body.playerId) : Number(eoi.penalty_amount || 0);
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

function validBadmintonScore(pointsA, pointsB, target = 21) {
  if (![pointsA, pointsB].every(value => Number.isInteger(value) && value >= 0 && value <= 30)) return { valid: false };
  if (pointsA === pointsB) return { valid: false };
  const winner = Math.max(pointsA, pointsB);
  const loser = Math.min(pointsA, pointsB);
  const valid = winner === 30 ? loser <= 29 : winner >= target && winner <= 29 && winner - loser >= 2;
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
    const target = [15, 21, 30].includes(Number(match.targetPoints)) ? Number(match.targetPoints) : 21;
    const bestOf = Number(match.bestOf) === 3 ? 3 : 1;
    let gameScores = Array.isArray(match.gameScores) ? match.gameScores.map(game => ({ a: Number(game.a), b: Number(game.b) })) : [];
    let gamesA = Number(match.gamesA), gamesB = Number(match.gamesB), pointsA = gamesA, pointsB = gamesB;
    if (bestOf === 1) {
      const checked = validBadmintonScore(gamesA, gamesB, target);
      if (!checked.valid) return reply({ error: `Enter a valid ${target}-point badminton score: win by 2, capped at 30.` }, 400);
      gameScores = [{ a: gamesA, b: gamesB }];
    } else {
      if (gameScores.length < 2 || gameScores.length > 3 || !gameScores.every(game => validBadmintonScore(game.a, game.b, target).valid)) {
        return reply({ error: `Enter two or three valid ${target}-point games for the best-of-3 match.` }, 400);
      }
      gamesA = gameScores.filter(game => game.a > game.b).length;
      gamesB = gameScores.filter(game => game.b > game.a).length;
      if (gamesA < 2 && gamesB < 2) return reply({ error: "A best-of-3 match must have a winner." }, 400);
      pointsA = gameScores.at(-1).a;
      pointsB = gameScores.at(-1).b;
    }
    const update = {
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      games_a: gamesA,
      games_b: gamesB,
      points_a: pointsA,
      points_b: pointsB,
      target_points: target,
      best_of: bestOf,
      status: "completed",
      current_game: gameScores.length,
      game_scores: gameScores,
      completed_at: new Date().toISOString(),
      submitted_by: body.submittedBy,
    };
    if (match.scoreId) {
      await db(`match_scores?id=eq.${encodeURIComponent(match.scoreId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update) });
    } else {
      inserts.push({ event_id: body.eventId, match_number: null, court_name: null, scheduled_start: null, scheduled_end: null, ...update, tiebreak_a: null, tiebreak_b: null });
    }
  }
  if (inserts.length) await db("match_scores", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(inserts) });
  return reply({ ok: true, saved: matches.length });
}

function scoreRowForTeam(row, team) {
  return team === "A" ? row.team_a_player_ids : row.team_b_player_ids;
}

function liveSnapshot(row) {
  return {
    status: row.status,
    current_game: row.current_game,
    games_a: row.games_a,
    games_b: row.games_b,
    points_a: row.points_a,
    points_b: row.points_b,
    target_points: row.target_points,
    best_of: row.best_of,
    server_team: row.server_team,
    server_player_id: row.server_player_id,
    server_position: row.server_position,
    game_scores: row.game_scores || [],
  };
}

async function createLiveMatch(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone)) {
    return reply({ error: "Live scoring opens when the session starts." }, 409);
  }
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (!attending.has(body.playerId)) return reply({ error: "Only players marked In for this session can score." }, 403);
  const teamA = Array.isArray(body.teamA) ? body.teamA.filter(Boolean) : [];
  const teamB = Array.isArray(body.teamB) ? body.teamB.filter(Boolean) : [];
  const allPlayers = [...teamA, ...teamB];
  if (teamA.length !== 2 || teamB.length !== 2 || new Set(allPlayers).size !== 4 || allPlayers.some(id => !attending.has(id))) {
    return reply({ error: "Every doubles match requires four different players marked In." }, 400);
  }
  const target = [15, 21, 30].includes(Number(body.targetPoints)) ? Number(body.targetPoints) : 21;
  const bestOf = Number(body.bestOf) === 3 ? 3 : 1;
  const serverId = allPlayers.includes(body.serverPlayerId) ? body.serverPlayerId : null;
  const serverTeam = serverId && teamA.includes(serverId) ? "A" : serverId && teamB.includes(serverId) ? "B" : null;
  const rows = await db("match_scores", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      event_id: body.eventId,
      match_number: null,
      court_name: body.courtName ? String(body.courtName) : null,
      scheduled_start: null,
      scheduled_end: null,
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      games_a: 0,
      games_b: 0,
      target_points: target,
      best_of: bestOf,
      status: "live",
      current_game: 1,
      points_a: 0,
      points_b: 0,
      server_team: serverTeam,
      server_player_id: serverId,
      server_position: serverId ? (body.serverPosition === "left" ? "left" : "right") : null,
      game_scores: [],
      score_history: [],
      started_at: new Date().toISOString(),
      submitted_by: body.playerId,
    }),
  });
  return reply({ ok: true, score: Array.isArray(rows) ? rows[0] : rows });
}

async function liveScore(body) {
  const rows = await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId || "")}&select=*`);
  const row = rows?.[0];
  if (!row) return reply({ error: "Scheduled match not found." }, 404);
  const event = await getEvent(row.event_id);
  if (!event) {
    return reply({ error: "Event not found." }, 404);
  }
  const action = body.action;
  if (action !== "configure" && new Date() < localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone)) {
    return reply({ error: "Live scoring opens when the session starts." }, 409);
  }
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(row.event_id)}&status=eq.yes&select=player_id`);
  if (!attendingRows.some(item => item.player_id === body.playerId)) return reply({ error: "Only players marked In for this session can score." }, 403);
  if (action === "configure") {
    if (row.status === "completed") return reply({ error: "A completed match cannot be reconfigured." }, 409);
    const target = Number(body.targetPoints), bestOf = Number(body.bestOf);
    if (![15, 21, 30].includes(target) || ![1, 3].includes(bestOf)) return reply({ error: "Choose 15, 21, or 30 points and 1 game or best of 3." }, 400);
    const teamA = scoreRowForTeam(row, "A"), teamB = scoreRowForTeam(row, "B");
    const serverId = body.serverPlayerId && [...teamA, ...teamB].includes(body.serverPlayerId) ? body.serverPlayerId : row.server_player_id;
    const serverTeam = serverId && teamA.includes(serverId) ? "A" : serverId && teamB.includes(serverId) ? "B" : row.server_team;
    await db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ target_points: target, best_of: bestOf, server_player_id: serverId || null, server_team: serverTeam || null, server_position: body.serverPosition === "left" ? "left" : "right", updated_at: new Date().toISOString() }) });
    return reply({ ok: true });
  }
  if (action === "start") {
    await db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "live", submitted_by: row.submitted_by || body.playerId, started_at: row.started_at || new Date().toISOString(), updated_at: new Date().toISOString() }) });
    return reply({ ok: true });
  }
  if (action === "undo") {
    const history = Array.isArray(row.score_history) ? [...row.score_history] : [];
    const previous = history.pop();
    if (!previous) return reply({ error: "There is no score to undo." }, 409);
    await db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...previous, score_history: history, updated_at: new Date().toISOString() }) });
    return reply({ ok: true });
  }
  if (!["pointA", "pointB"].includes(action)) return reply({ error: "Unknown live scoring action." }, 400);
  const before = liveSnapshot(row);
  const pointsA = Number(row.points_a || 0) + (action === "pointA" ? 1 : 0);
  const pointsB = Number(row.points_b || 0) + (action === "pointB" ? 1 : 0);
  const history = [...(Array.isArray(row.score_history) ? row.score_history : []), before].slice(-120);
  const patch = { status: "live", submitted_by: row.submitted_by || body.playerId, points_a: pointsA, points_b: pointsB, server_team: action === "pointA" ? "A" : "B", server_position: (pointsA + pointsB) % 2 === 0 ? "right" : "left", score_history: history, updated_at: new Date().toISOString(), started_at: row.started_at || new Date().toISOString() };
  patch.server_player_id = action === "pointA" ? row.team_a_player_ids[0] : row.team_b_player_ids[0];
  const winner = validBadmintonScore(pointsA, pointsB, Number(row.target_points || 21)).valid;
  if (winner) {
    const bestOf = Number(row.best_of || 1);
    if (bestOf === 1) {
      patch.games_a = pointsA;
      patch.games_b = pointsB;
      patch.game_scores = [{ a: pointsA, b: pointsB }];
      patch.status = "completed";
      patch.completed_at = new Date().toISOString();
    } else {
      const gameScores = [...(Array.isArray(row.game_scores) ? row.game_scores : []), { a: pointsA, b: pointsB }];
      const gamesA = Number(row.games_a || 0) + (pointsA > pointsB ? 1 : 0);
      const gamesB = Number(row.games_b || 0) + (pointsB > pointsA ? 1 : 0);
      patch.game_scores = gameScores;
      patch.games_a = gamesA;
      patch.games_b = gamesB;
      if (gamesA >= 2 || gamesB >= 2) {
        patch.status = "completed";
        patch.completed_at = new Date().toISOString();
      } else {
        patch.current_game = Number(row.current_game || 1) + 1;
        patch.points_a = 0;
        patch.points_b = 0;
        patch.server_team = null;
        patch.server_player_id = null;
        patch.server_position = null;
      }
    }
  }
  await db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  return reply({ ok: true, completed: patch.status === "completed" });
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
  const allowed = ["event_date", "start_time", "end_time", "location", "suburb", "court_1_name", "court_fee", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_2_fee", "court_3_enabled", "court_3_name", "court_3_start_time", "court_3_end_time", "court_3_fee", "shuttle_fee", "account_closed"];
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
  if (["event_date", "start_time", "end_time", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_3_enabled", "court_3_name", "court_3_start_time", "court_3_end_time"].some(key => key in update)) {
    const savedEvent = await getEvent(body.eventId);
    if (savedEvent) {
      const force = !isThursdayEvent(savedEvent) || new Date() >= thursdayScheduleAt(savedEvent);
      await generateEventSchedule(body.eventId, { force });
    }
  }
  return reply({ ok: true });
}

async function adminSaveMatch(body) {
  if (!body.scoreId) return reply({ error: "Match not found." }, 404);
  const rows = await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}&select=*`);
  const row = rows?.[0];
  if (!row) return reply({ error: "Match not found." }, 404);
  const event = await getEvent(row.event_id);
  if (!event) return reply({ error: "Event not found." }, 404);
  const teamA = Array.isArray(body.teamA) ? body.teamA.filter(Boolean) : row.team_a_player_ids;
  const teamB = Array.isArray(body.teamB) ? body.teamB.filter(Boolean) : row.team_b_player_ids;
  const attending = new Set((await db(`eois?event_id=eq.${encodeURIComponent(row.event_id)}&status=eq.yes&select=player_id`)).map(item => item.player_id));
  const all = [...teamA, ...teamB];
  if (teamA.length !== 2 || teamB.length !== 2 || new Set(all).size !== 4 || all.some(id => !attending.has(id))) return reply({ error: "Choose four different players marked In." }, 400);
  const target = Number(body.targetPoints || row.target_points || 21);
  const bestOf = Number(body.bestOf || row.best_of || 1);
  if (![15, 21, 30].includes(target) || ![1, 3].includes(bestOf)) return reply({ error: "Choose a valid point target and match format." }, 400);
  const courtName = String(body.courtName || row.court_name || "Court 1");
  const scheduledStart = body.scheduledStart || row.scheduled_start;
  const scheduledEnd = body.scheduledEnd || row.scheduled_end;
  const pairingChanged = JSON.stringify(teamA) !== JSON.stringify(row.team_a_player_ids || []) || JSON.stringify(teamB) !== JSON.stringify(row.team_b_player_ids || []);
  const scheduleChanged = courtName !== String(row.court_name || "Court 1") || scheduledStart !== row.scheduled_start || scheduledEnd !== row.scheduled_end;
  await db(`match_scores?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      court_name: courtName,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      target_points: target,
      best_of: bestOf,
      pairing_manual: Boolean(row.pairing_manual || pairingChanged),
      schedule_manual: Boolean(row.schedule_manual || scheduleChanged),
      updated_at: new Date().toISOString(),
    }),
  });
  return reply({ ok: true });
}

async function savePairing(body) {
  const eventId = String(body.eventId || "");
  const playerId = String(body.playerId || "");
  const pairings = Array.isArray(body.pairings) ? body.pairings.map(pair => Array.isArray(pair) ? pair.filter(Boolean) : []) : [];
  if (!eventId || !playerId || !pairings.length) return reply({ error: "Add the complete pairing set before saving." }, 400);
  const event = await getEvent(eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (!attending.has(playerId)) return reply({ error: "Only attendees can edit the pairings." }, 403);
  if (pairings.some(pair => pair.length !== 2 || new Set(pair).size !== 2)) return reply({ error: "Each pairing needs two different players." }, 400);
  const allPlayers = pairings.flat();
  if (allPlayers.some(id => !attending.has(id))) return reply({ error: "Choose players marked In for this session." }, 400);
  if (new Set(allPlayers).size !== allPlayers.length) return reply({ error: "Each attendee can only appear in one pairing. Make all changes, then save the full set." }, 400);
  await saveEventPairings(eventId, pairings);
  const schedule = await generateEventSchedule(eventId, { force: true });
  const scores = await db(`match_scores?event_id=eq.${encodeURIComponent(eventId)}&select=*&order=match_number.asc`);
  return reply({ ok: true, updated: pairings.length, pairings, scores, scheduleUpdated: schedule.saved });
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
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  await lockDueThursdayEois(event);
  const currentRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=*`);
  const current = currentRows?.[0];
  if (body.status === "none") {
    await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return reply({ ok: true });
  }
  let penaltyAmount = Number(current?.penalty_amount || 0);
  let lockedIn = Boolean(current?.locked_in);
  let lockedAt = current?.locked_at || null;
  if (body.status === "no" && current?.status === "yes" && (lockedIn || (isThursdayEvent(event) && new Date() >= thursdayLockAt(event)))) {
    const lockedRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&locked_in=eq.true&select=player_id`);
    const lockedCount = Math.max(lockedRows.length, 1);
    penaltyAmount = Number((totalCourtFee(event) / lockedCount).toFixed(2));
    lockedIn = true;
    lockedAt = lockedAt || thursdayLockAt(event).toISOString();
  }
  if (body.status === "yes" && penaltyAmount) penaltyAmount = 0;
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      status: body.status,
      locked_in: lockedIn,
      locked_at: lockedAt,
      penalty_amount: penaltyAmount,
      updated_at: new Date().toISOString(),
    }),
  });
  if (penaltyAmount) {
    await db("payments?on_conflict=event_id,player_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, amount: penaltyAmount, paid: false, paid_at: null, updated_at: new Date().toISOString() }),
    });
  } else if (body.status === "yes") {
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  }
  if (body.status === "yes") {
    const force = isThursdayEvent(event) && new Date() >= thursdayScheduleAt(event);
    if (force) await generateEventSchedule(body.eventId, { force: true });
    else await maybeGenerateEventSchedule(body.eventId);
  }
  if (body.status === "no" && !penaltyAmount) {
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
  const eoiRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,status,penalty_amount`);
  const eoi = eoiRows.find(row => row.player_id === body.playerId);
  const attending = eoiRows.filter(row => row.status === "yes");
  if (!eoi || (eoi.status !== "yes" && Number(eoi.penalty_amount || 0) <= 0)) return reply({ error: "Only players with a session payment or late cancellation penalty can have a payment recorded." }, 409);
  const hours = await db(`event_player_hours?event_id=eq.${encodeURIComponent(body.eventId)}&select=player_id,hours_played`);
  const amount = eoi.status === "yes" ? calculatePlayerAmount(event, attending, hours, body.playerId) : Number(eoi.penalty_amount || 0);
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
    if (req.method === "POST" && action === "live-score-new") return createLiveMatch(body);
    if (req.method === "POST" && action === "live-score") return liveScore(body);
    if (req.method === "POST" && action === "media-upload-url") return createMediaUpload(body);
    if (req.method === "POST" && action === "media-finalize") return finalizeMediaUpload(body);
    if (req.method === "POST" && action === "admin-login") return adminLogin(body);
    if (req.method === "POST" && action === "save-pairing") return savePairing(body);
    if (req.method === "GET" && action === "admin-state") {
      if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
      return reply(await adminState());
    }

    if (!["admin-change-passcode", "admin-save-event", "admin-generate-schedule", "admin-save-match", "admin-delete-event", "admin-add-player", "admin-update-player", "admin-remove-player", "admin-set-eoi", "admin-set-payment", "admin-set-hours", "admin-delete-score", "admin-delete-media"].includes(action)) {
      return reply({ error: "Unknown action." }, 404);
    }
    if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
    if (action === "admin-change-passcode") return changePasscode(body);
    if (action === "admin-save-event") return saveEvent(body);
    if (action === "admin-generate-schedule") return reply(await generateEventSchedule(body.eventId));
    if (action === "admin-save-match") return adminSaveMatch(body);
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

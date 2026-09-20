import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const INITIAL_PASSCODE = process.env.INITIAL_ADMIN_PASSCODE || "1234";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "https://kingsmenclub.netlify.app";
const APP_VERSION = process.env.APP_VERSION || process.env.COMMIT_REF || "local";
// Publishable keys are safe to expose to the browser; the service-role key never leaves this function.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_AYFrOSmDDI5os5wSQSddZw_rUlDcvo2";
const SYDNEY = "Australia/Sydney";
const SYDNEY_SPORTS_CLUB_LOCATION_ID = "sydney-sports-club-kings-park";
const BADMINTONWORX_LOCATION_ID = "badmintonworx-norwest";
const MEDIA_BUCKET = "kingsmen-media";
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const rateLimitBuckets = new Map();
let maintenanceAt = 0;
let maintenancePromise = null;

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });

function requireConfiguration() {
  if (!SUPABASE_URL || !SERVICE_KEY || !SESSION_SECRET) {
    throw new Error("Server environment variables are not configured.");
  }
}

function requestId(req) {
  return String(req.headers.get("x-kbc-request-id") || randomUUID()).slice(0, 120);
}

function consumeRateLimit(req, action, limit = 12, windowMs = 10 * 60 * 1000) {
  const forwarded = String(req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const key = `${action}:${forwarded || "unknown"}`;
  const now = Date.now();
  const current = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > current.resetAt) { current.count = 0; current.resetAt = now + windowMs; }
  current.count += 1;
  rateLimitBuckets.set(key, current);
  if (rateLimitBuckets.size > 2000) {
    for (const [bucketKey, bucket] of rateLimitBuckets) if (bucket.resetAt < now) rateLimitBuckets.delete(bucketKey);
  }
  return current.count <= limit;
}

async function runMaintenanceOnce() {
  if (Date.now() - maintenanceAt < 30_000) return;
  if (maintenancePromise) return maintenancePromise;
  maintenancePromise = (async () => {
    await ensureUpcomingEvents();
    await maintainThursdaySessions();
    maintenanceAt = Date.now();
  })()
    .finally(() => { maintenancePromise = null; });
  return maintenancePromise;
}

function pushConfigured() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
}

function configurePush() {
  if (pushConfigured()) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return pushConfigured();
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

function locationIdForValues(location, suburb, fallback = null) {
  const locationText = String(location || "").trim().toLowerCase();
  const suburbText = String(suburb || "").trim().toLowerCase();
  if ((locationText === "sydney sports club"
    || locationText === "sydney sports park"
    || locationText === "sydney sports club - kings park"
    || locationText === "sydney sports park - kings park")
    && suburbText === "kings park") return SYDNEY_SPORTS_CLUB_LOCATION_ID;
  if (locationText === "badmintonworx norwest" || locationText === "badmintonworx - norwest") return BADMINTONWORX_LOCATION_ID;
  return fallback || null;
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

async function loadPlayers() {
  const guestSelect = "id,name,active,pin_hash,is_guest,guest_event_id";
  try {
    return await db(`players?select=${guestSelect}&order=name.asc`);
  } catch (error) {
    // Keep the existing clubhouse usable while an optional guest migration is pending.
    // Guest creation remains unavailable until the migration adds these columns.
    if (!String(error?.message || "").includes("is_guest")) throw error;
    const rows = await db("players?select=id,name,active,pin_hash&order=name.asc");
    return (rows || []).map((player) => ({ ...player, is_guest: false, guest_event_id: null }));
  }
}

async function playerIsGuest(playerId) {
  try {
    const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&select=is_guest`);
    return Boolean(rows?.[0]?.is_guest);
  } catch (error) {
    // The guest columns are optional until migration 023 is applied.
    if (String(error?.message || "").includes("is_guest")) return false;
    throw error;
  }
}

function auditActor(req, action, body) {
  if (action === "admin-login") return { type: "admin", id: body.__adminActorId || playerSession(req)?.playerId || (body.playerPin && body.playerId ? String(body.playerId) : null) };
  if (isAdmin(req)) return { type: "admin", id: adminSession(req)?.playerId || playerSession(req)?.playerId || null };
  const playerId = body.playerId || body.submittedBy || (action === "player-pin" ? body.playerId : null);
  return playerId ? { type: "player", id: String(playerId) } : { type: "anonymous", id: null };
}

function auditTarget(action, body) {
  if (action === "view-tab") return { type: "page", id: String(body.page || "") || null };
  if (body.eventId) return { type: "event", id: String(body.eventId) };
  if (body.scoreId) return { type: "match_score", id: String(body.scoreId) };
  if (body.playerId) return { type: "player", id: String(body.playerId) };
  if (body.tournamentId) return { type: "tournament", id: String(body.tournamentId) };
  if (body.mediaId) return { type: "media", id: String(body.mediaId) };
  return { type: action, id: null };
}

function auditDetails(body) {
  const details = {};
  const scalarKeys = [
    "eventId", "playerId", "submittedBy", "scoreId", "tournamentId", "mediaId",
    "status", "paid", "hoursPlayed", "shuttleFee", "targetPoints", "bestOf",
    "courtName", "scheduledStart", "scheduledEnd", "mode", "fileName", "action",
    "announcementId", "matchId", "locationId", "role", "partnerPlayerId", "position", "urgent", "audience", "targetPlayerCount",
    "courtCount", "matchMinutes", "changeoverMinutes", "entryFee", "kind", "title",
    "adminTab", "tab", "tabLabel", "page", "pageLabel", "section", "sectionLabel",
    "applyPenalty", "expectedUpdatedAt", "expectedRevision", "clientActionId", "reason", "source",
  ];
  for (const key of scalarKeys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") details[key] = body[key];
  }
  if (typeof body.name === "string" && body.name.trim()) details.name = body.name.trim().slice(0, 120);
  if (typeof body.description === "string" && body.description.trim()) details.description = body.description.trim().slice(0, 240);
  if (Array.isArray(body.permissions)) details.permissions = body.permissions.slice(0, 20);
  if (Array.isArray(body.matches)) details.matchCount = body.matches.length;
  if (Array.isArray(body.pairings)) details.pairingCount = body.pairings.length;
  if (body.changes && typeof body.changes === "object") details.changedFields = Object.keys(body.changes).slice(0, 40);
  if (body.currentPasscode !== undefined || body.newPasscode !== undefined) details.passcodeChanged = true;
  if (body.pin !== undefined) details.pinProvided = true;
  if (body.__adminRole) details.adminRole = body.__adminRole;
  if (body.__adminIdentity) details.adminIdentity = body.__adminIdentity;
  if (body.__pushDelivery && typeof body.__pushDelivery === "object") {
    details.pushDelivery = {
      configured: Boolean(body.__pushDelivery.configured),
      sent: Number(body.__pushDelivery.sent || 0),
      failed: Number(body.__pushDelivery.failed || 0),
      skipped: Number(body.__pushDelivery.skipped || 0),
    };
  }
  return details;
}

function snapshotChangedFields(before, after) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const ignored = new Set(["id", "created_at", "updated_at", "completed_at", "paid_at", "locked_at"]);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !ignored.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

async function writeAuditLog({ req, action, body, response, failed = false }) {
  const actor = auditActor(req, action, body);
  const target = auditTarget(action, body);
  const session = isAdmin(req) ? adminSession(req) : null;
  const verifiedPlayer = playerSession(req);
  const details = {
    ...auditDetails(body),
    requestId: requestId(req),
    appVersion: APP_VERSION,
    ...(session ? {
      adminRole: session.role,
      adminIdentity: session.playerId ? "player-pin" : verifiedPlayer ? "shared-passcode-with-player-session" : "shared-passcode",
    } : {}),
  };
  const changedFields = snapshotChangedFields(body.__auditBefore, body.__auditAfter);
  if (changedFields.length) details.changedFields = changedFields.slice(0, 40);
  try {
    await db("audit_logs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        actor_type: actor.type,
        actor_id: actor.id,
        action,
        target_type: target.type,
        target_id: target.id,
        status_code: response?.status || 500,
        succeeded: !failed && (response?.status || 500) < 400,
        details,
        before_data: body.__auditBefore || null,
        after_data: body.__auditAfter || null,
      }),
    });
  } catch (error) {
    console.error("Audit log write failed", error);
  }
}

async function audited(req, action, body, handler) {
  try {
    body.__auditBefore = await auditSnapshot(action, body);
    const response = await handler();
    body.__auditAfter = await auditSnapshot(action, body);
    await writeAuditLog({ req, action, body, response });
    return response;
  } catch (error) {
    await writeAuditLog({ req, action, body, failed: true });
    throw error;
  }
}

async function auditSnapshot(action, body) {
  try {
    let table = null;
    let query = null;
    if (body.eventId && ["eoi", "admin-set-eoi"].includes(action)) {
      table = "eois";
      query = `event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId || "")}&select=*`;
    } else if (body.eventId && ["paid", "admin-set-payment"].includes(action)) {
      table = "payments";
      query = `event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId || "")}&select=*`;
    } else if (body.eventId && ["admin-save-event", "admin-delete-event"].includes(action)) {
      table = "events";
      query = `id=eq.${encodeURIComponent(body.eventId)}&select=*`;
    } else if (body.eventId && body.playerId && action === "admin-set-hours") {
      table = "event_player_hours";
      query = `event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=*`;
    } else if (body.scoreId) {
      table = "match_scores";
      query = `id=eq.${encodeURIComponent(body.scoreId)}&select=*`;
    } else if (body.playerId && ["admin-update-player", "admin-remove-player", "admin-reset-player-pin", "player-pin"].includes(action)) {
      table = "players";
      query = `id=eq.${encodeURIComponent(body.playerId)}&select=*`;
    } else if (body.tournamentId && action.startsWith("admin-")) {
      table = "tournaments";
      query = `id=eq.${encodeURIComponent(body.tournamentId)}&select=*`;
    } else if (body.announcementId) {
      table = "announcements";
      query = `id=eq.${encodeURIComponent(body.announcementId)}&select=*`;
    }
    if (!table || !query) return null;
    const rows = await db(`${table}?${query}`);
    if (!rows?.[0]) return null;
    const { pin_hash, ...safe } = rows[0];
    return safe;
  } catch (error) {
    console.error("Audit snapshot failed", error);
    return null;
  }
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
      location: "Sydney Sports Park - Kings Park",
      suburb: "Kings Park",
      location_id: SYDNEY_SPORTS_CLUB_LOCATION_ID,
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
    location: "BadmintonWorx - Norwest",
    suburb: "Norwest",
    location_id: BADMINTONWORX_LOCATION_ID,
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
  await syncDefaultCourtFees();
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const minutes = Math.max(0, value);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
}

function rateDayType(eventDate) {
  const day = new Date(`${eventDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

function courtFeeFromRates(eventDate, startTime, endTime, rates) {
  let start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) end += 1440;
  const duration = end - start;
  let covered = 0;
  let total = 0;
  for (let dayOffset = 0; dayOffset <= Math.ceil(end / 1440); dayOffset += 1) {
    const segmentStart = Math.max(start, dayOffset * 1440);
    const segmentEnd = Math.min(end, (dayOffset + 1) * 1440);
    if (segmentEnd <= segmentStart) continue;
    const dayRates = rates.filter(rate => rate.day_type === rateDayType(shiftLocalDate(eventDate, dayOffset)));
    for (const rate of dayRates) {
      const overlapStart = Math.max(segmentStart - dayOffset * 1440, Number(rate.start_minute));
      const overlapEnd = Math.min(segmentEnd - dayOffset * 1440, Number(rate.end_minute));
      if (overlapEnd > overlapStart) {
        const minutes = overlapEnd - overlapStart;
        covered += minutes;
        total += minutes / 60 * Number(rate.hourly_rate);
      }
    }
  }
  if (covered !== duration) return null;
  return Number(total.toFixed(2));
}

function automaticCourtFees(event, rates) {
  if (!event.location_id || !rates.length) return null;
  const courtFee = courtFeeFromRates(event.event_date, event.start_time, event.end_time, rates);
  const court2Fee = event.court_2_enabled
    ? courtFeeFromRates(event.event_date, event.court_2_start_time, event.court_2_end_time, rates)
    : Number(event.court_2_fee || 0);
  const court3Fee = event.court_3_enabled
    ? courtFeeFromRates(event.event_date, event.court_3_start_time, event.court_3_end_time, rates)
    : Number(event.court_3_fee || 0);
  if ([courtFee, court2Fee, court3Fee].some(value => value === null)) return null;
  return { court_fee: courtFee, court_2_fee: court2Fee, court_3_fee: court3Fee };
}

async function locationRates(locationId) {
  return db(`location_court_rates?location_id=eq.${encodeURIComponent(locationId)}&select=day_type,start_minute,end_minute,hourly_rate&order=day_type,start_minute`);
}

async function syncDefaultCourtFees() {
  const today = datePartsInSydney();
  const todayText = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const events = await db(`events?location_id=not.is.null&event_date=gte.${todayText}&select=*`);
  const rateSets = Object.fromEntries(await Promise.all(
    [...new Set(events.map(event => event.location_id).filter(Boolean))]
      .map(async locationId => [locationId, await locationRates(locationId)])
  ));
  await Promise.all(events.map(async event => {
    const fees = automaticCourtFees(event, rateSets[event.location_id] || []);
    if (!fees) return;
    const update = { updated_at: new Date().toISOString() };
    if (!event.court_fee_manual) update.court_fee = fees.court_fee;
    if (!event.court_2_fee_manual) update.court_2_fee = fees.court_2_fee;
    if (!event.court_3_fee_manual) update.court_3_fee = fees.court_3_fee;
    const changed = Object.keys(update).some(key => key !== "updated_at" && Number(update[key]) !== Number(event[key]));
    if (changed) await db(`events?id=eq.${encodeURIComponent(event.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update) });
  }));
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
    if (event.schedule_generated_at && new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) {
      const [pairingSetting, scheduledRows] = await Promise.all([
        db(`app_settings?key=eq.${encodeURIComponent(`pairings:${event.id}`)}&select=value`),
        db(`match_scores?event_id=eq.${encodeURIComponent(event.id)}&status=eq.scheduled&select=team_a_player_ids,team_b_player_ids,pairing_manual,schedule_manual`),
      ]);
      let savedPairings = null;
      try { savedPairings = pairingSetting?.[0]?.value ? JSON.parse(pairingSetting[0].value) : null; } catch { savedPairings = null; }
      const savedKeys = new Set((Array.isArray(savedPairings) ? savedPairings : []).filter(pair => Array.isArray(pair)).map(pair => pairingKey(pair)));
      const scheduleNeedsPairingRefresh = !Array.isArray(savedPairings) || scheduledRows.some(row => !savedKeys.has(pairingKey(row.team_a_player_ids)) || !savedKeys.has(pairingKey(row.team_b_player_ids)));
      const hasManualRows = scheduledRows.some(row => row.pairing_manual || row.schedule_manual);
      if (scheduleNeedsPairingRefresh && !hasManualRows) await generateEventSchedule(event.id, { force: true });
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

function signSession(role = "owner") {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function signAdminSession(role = "owner", playerId = null) {
  const payload = Buffer.from(JSON.stringify({ role, playerId, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function signPlayerSession(playerId) {
  const payload = Buffer.from(JSON.stringify({ kind: "player", playerId, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sessionFromToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.exp > Date.now() ? session : null;
  } catch { return null; }
}

function playerSession(req) {
  const tokens = [req.headers.get("x-kbc-player-authorization"), req.headers.get("authorization")]
    .filter(Boolean).map(value => String(value).replace(/^Bearer\s+/i, ""));
  return tokens.map(sessionFromToken).find(session => session?.kind === "player") || null;
}

function isPlayer(req, playerId) {
  return playerSession(req)?.playerId === playerId;
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

function adminRole(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.exp > Date.now() ? (session.role || "owner") : null;
  } catch { return null; }
}

function adminSession(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.exp > Date.now() && session.role ? session : null;
  } catch { return null; }
}

const ADMIN_PERMISSIONS = {
  owner: new Set(["events", "schedule", "eoi", "money", "scores", "roster", "media", "tournaments", "announcements", "roles", "audit"]),
  admin: new Set(["events", "schedule", "eoi", "money", "scores", "roster", "media", "tournaments", "announcements", "audit"]),
  treasurer: new Set(["money", "audit"]),
  scheduler: new Set(["events", "schedule", "eoi", "audit"]),
  scorekeeper: new Set(["scores", "schedule", "audit"]),
  media: new Set(["media", "audit"]),
};

const ALL_ADMIN_PERMISSIONS = new Set(["events", "schedule", "eoi", "money", "scores", "roster", "media", "tournaments", "announcements", "roles", "audit"]);

async function adminPermissionSet(role) {
  if (!role) return new Set();
  const rows = await db(`admin_role_definitions?slug=eq.${encodeURIComponent(role)}&select=active,permissions`);
  if (rows?.length && !rows[0].active) return new Set();
  if (rows?.length) {
    const permissions = rows[0].permissions;
    return new Set(Array.isArray(permissions) ? permissions.filter(permission => ALL_ADMIN_PERMISSIONS.has(permission)) : []);
  }
  if (ADMIN_PERMISSIONS[role]) return ADMIN_PERMISSIONS[role];
  return new Set();
}

async function hasAdminPermission(req, permission) {
  const role = adminRole(req);
  const permissions = await adminPermissionSet(role);
  return permissions.has(permission);
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

async function appState(req) {
  await runMaintenanceOnce();
  const [playerRows, events, eois, payments, scores, mediaRows, locations, locationCourtRates, tournaments, waitlist, notificationPreferences, announcements, tournamentEntries, tournamentMatches] = await Promise.all([
    loadPlayers(),
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,locked_in,locked_at,penalty_amount,updated_at"),
    db("payments?select=event_id,player_id,amount,paid,paid_at"),
    db("match_scores?select=*&order=created_at.asc"),
    db("media_items?select=*&order=captured_at.desc,created_at.desc"),
    db("locations?select=id,name,suburb,timezone,active&active=eq.true&order=name.asc"),
    db("location_court_rates?select=location_id,day_type,start_minute,end_minute,hourly_rate&order=location_id,day_type,start_minute"),
    db("tournaments?select=*&order=tournament_date.asc,created_at.desc"),
    db("event_waitlist?select=*&order=event_id,position"),
    db("player_notification_preferences?select=*&order=player_id"),
    db("announcements?select=*&archived_at=is.null&order=pinned.desc,created_at.desc"),
    db("tournament_entries?select=*&order=created_at.asc"),
    db("tournament_matches?select=*&order=tournament_id,round,match_number"),
  ]);
  const playerHours = await db("event_player_hours?select=event_id,player_id,hours_played,updated_at");
  const players = playerRows.map(({ pin_hash, ...player }) => ({ ...player, has_pin: Boolean(pin_hash) }));
  const media = mediaRows.map(item => ({ ...item, public_url: publicMediaUrl(item.storage_path) }));
  const eventPairings = Object.fromEntries(await Promise.all(events.map(async event => {
    const rows = await db(`app_settings?key=eq.${encodeURIComponent(`pairings:${event.id}`)}&select=value`);
    const value = rows?.[0]?.value;
    try { return [event.id, value ? JSON.parse(value) : null]; } catch { return [event.id, null]; }
  })));
  const currentPlayerId = playerSession(req)?.playerId;
  const visibleAnnouncements = (announcements || []).filter((announcement) => announcement.audience !== "attendees"
    || (currentPlayerId && eois.some((eoi) => eoi.event_id === announcement.event_id && eoi.player_id === currentPlayerId && eoi.status === "yes")));
  return { players, events, eois, payments, scores, media, playerHours, eventPairings, locations, locationCourtRates, tournaments, waitlist, notificationPreferences, announcements: visibleAnnouncements, tournamentEntries, tournamentMatches, serverNow: new Date().toISOString(), appVersion: APP_VERSION };
}

async function adminState(req) {
  const [rows, roles, roleDefinitions, subscriptions, preferences, announcements, notificationDelivery] = await Promise.all([
    loadPlayers(),
    db("admin_roles?select=*&order=role,player_id"),
    db("admin_role_definitions?select=*&order=is_system.desc,name.asc"),
    db("push_subscriptions?select=player_id,last_seen_at&order=last_seen_at.desc"),
    db("player_notification_preferences?select=player_id,announcements"),
    db("announcements?select=*&archived_at=is.null&order=created_at.desc"),
    db("push_delivery_log?select=id,created_at,player_id,announcement_id,kind,succeeded,error_message&order=created_at.desc&limit=100").catch(() => []),
  ]);
  const currentRole = adminRole(req);
  const preferenceByPlayer = new Map((preferences || []).map(row => [String(row.player_id), row]));
  const deviceByPlayer = new Map();
  for (const subscription of subscriptions || []) {
    const key = String(subscription.player_id);
    const current = deviceByPlayer.get(key) || { count: 0, lastSeenAt: null };
    current.count += 1;
    if (!current.lastSeenAt || String(subscription.last_seen_at) > current.lastSeenAt) current.lastSeenAt = subscription.last_seen_at;
    deviceByPlayer.set(key, current);
  }
  const players = rows.map(({ pin_hash, ...player }) => {
    const devices = deviceByPlayer.get(String(player.id)) || { count: 0, lastSeenAt: null };
    const announcements = preferenceByPlayer.get(String(player.id))?.announcements !== false;
    return {
      ...player,
      has_pin: Boolean(pin_hash),
      push_device_count: devices.count,
      push_last_seen_at: devices.lastSeenAt,
      announcement_alerts_enabled: announcements,
      alerts_ready: devices.count > 0 && announcements,
    };
  });
  return { players, roles: roles || [], roleDefinitions: roleDefinitions || [], announcements: announcements || [], notificationDelivery: notificationDelivery || [], currentRole, permissions: [...await adminPermissionSet(currentRole)], canManageRoles: currentRole === "owner", appVersion: APP_VERSION, serverNow: new Date().toISOString() };
}

async function adminExport() {
  const [players, events, eois, payments, scores, hours, media, tournaments, entries, matches, audit] = await Promise.all([
    loadPlayers(),
    db("events?select=*&order=event_date.asc"),
    db("eois?select=*&order=event_id,player_id"),
    db("payments?select=*&order=event_id,player_id"),
    db("match_scores?select=*&order=event_id,match_number"),
    db("event_player_hours?select=*&order=event_id,player_id"),
    db("media_items?select=*&order=captured_at.desc"),
    db("tournaments?select=*&order=tournament_date.asc"),
    db("tournament_entries?select=*&order=created_at.asc"),
    db("tournament_matches?select=*&order=tournament_id,round,match_number"),
    db("audit_logs?select=*&order=created_at.desc&limit=5000"),
  ]);
  return reply({ exportedAt: new Date().toISOString(), appVersion: APP_VERSION, players: (players || []).map(({ pin_hash, ...player }) => player), events, eois, payments, scores, hours, media, tournaments, entries, matches, audit });
}

async function adminRoleHolders() {
  const [assignments, definitions] = await Promise.all([
    db("admin_roles?active=eq.true&select=player_id,role&order=player_id"),
    db("admin_role_definitions?active=eq.true&select=slug,name"),
  ]);
  const activeAssignments = Array.isArray(assignments) ? assignments : [];
  const ids = [...new Set(activeAssignments.map((assignment) => String(assignment.player_id)).filter(Boolean))];
  if (!ids.length) return { players: [] };
  const players = await db(`players?id=in.(${ids.join(",")})&active=eq.true&select=id,name&order=name.asc`);
  const roleNames = new Map((definitions || []).map((definition) => [String(definition.slug), definition.name]));
  const rolesByPlayer = new Map(activeAssignments
    .filter((assignment) => assignment.role === "owner" || roleNames.has(String(assignment.role)))
    .map((assignment) => [String(assignment.player_id), assignment.role]));
  return {
    players: (players || []).map((player) => {
      const role = rolesByPlayer.get(String(player.id));
      return { id: player.id, name: player.name, role, roleName: roleNames.get(String(role)) || role || "Admin" };
    }),
  };
}

async function adminAuditLog(filters = {}) {
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const clauses = [`select=id,created_at,actor_type,actor_id,action,target_type,target_id,status_code,succeeded,details,before_data,after_data,reverted_at,reverted_by`, "order=created_at.desc", `limit=${limit + 1}`, `offset=${offset}`];
  if (filters.actorId) clauses.push(`actor_id=eq.${encodeURIComponent(filters.actorId)}`);
  if (filters.action) clauses.push(`action=eq.${encodeURIComponent(filters.action)}`);
  if (filters.failed === "true") clauses.push("succeeded=eq.false");
  const [logs, players] = await Promise.all([
    db(`audit_logs?${clauses.join("&")}`),
    db("players?select=id,name"),
  ]);
  const names = new Map((players || []).map(player => [String(player.id), player.name]));
  const rows = Array.isArray(logs) ? logs : [];
  const hasMore = rows.length > limit;
  return { logs: rows.slice(0, limit).map(log => ({ ...log, actor_name: log.actor_id ? names.get(String(log.actor_id)) || null : null, app_version: APP_VERSION })), offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null };
}

const ADMIN_TAB_LABELS = {
  events: "Weekly events",
  schedule: "Schedule",
  eois: "EOI manager",
  roster: "Player roster",
  money: "Payment tracking",
  adminScores: "Scores",
  auditLog: "Audit log",
  communications: "Communications",
  settings: "Settings",
};

const PAGE_LABELS = {
  play: "Play",
  scores: "Scores",
  tournaments: "Tournaments",
  media: "Media",
  payments: "Payments",
  admin: "Admin",
};

async function adminViewTab(body) {
  const tab = String(body.adminTab || body.tab || "");
  const tabLabel = ADMIN_TAB_LABELS[tab];
  if (!tabLabel) return reply({ error: "Unknown Admin tab." }, 400);
  body.adminTab = tab;
  body.tabLabel = tabLabel;
  return reply({ ok: true });
}

async function viewPage(body) {
  const page = String(body.page || "");
  const pageLabel = PAGE_LABELS[page];
  if (!pageLabel) return reply({ error: "Unknown clubhouse page." }, 400);
  body.page = page;
  body.pageLabel = pageLabel;
  return reply({ ok: true });
}

async function scoreState(eventId) {
  const filter = eventId ? `&event_id=eq.${encodeURIComponent(eventId)}` : "";
  const scores = await db(`match_scores?select=*&order=match_number.asc,created_at.asc${filter}`);
  return { scores: Array.isArray(scores) ? scores : [], serverNow: new Date().toISOString() };
}

async function promoteWaitlist(eventId) {
  const event = await getEvent(eventId);
  if (!event) return 0;
  const [yesRows, pendingRows] = await Promise.all([
    db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`),
    db(`event_waitlist?event_id=eq.${encodeURIComponent(eventId)}&status=eq.pending&order=position.asc,created_at.asc&select=*`),
  ]);
  let available = eventCapacity(event) - yesRows.length;
  let promoted = 0;
  for (const waitlisted of pendingRows) {
    if (available <= 0) break;
    await db("eois?on_conflict=event_id,player_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ event_id: eventId, player_id: waitlisted.player_id, status: "yes", locked_in: false, penalty_amount: 0, updated_at: new Date().toISOString() }),
    });
    await db(`event_waitlist?id=eq.${encodeURIComponent(waitlisted.id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "promoted", promoted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    available -= 1;
    promoted += 1;
  }
  return promoted;
}

function cleanRolePermissions(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(permission => ALL_ADMIN_PERMISSIONS.has(permission)))];
}

async function getRoleDefinition(slug) {
  const rows = await db(`admin_role_definitions?slug=eq.${encodeURIComponent(String(slug || ""))}&select=*`);
  return rows?.[0] || null;
}

async function setAdminRole(body) {
  if (!body.playerId || !body.role) return reply({ error: "Choose a player and valid role." }, 400);
  const definition = await getRoleDefinition(body.role);
  if (!definition || !definition.active) return reply({ error: "That admin role is no longer active." }, 400);
  await db("admin_roles?on_conflict=player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ player_id: body.playerId, role: body.role, active: body.active !== false, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function createAdminRole(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 60) return reply({ error: "Role name must be between 2 and 60 characters." }, 400);
  const permissions = cleanRolePermissions(body.permissions);
  if (!permissions.length) return reply({ error: "Choose at least one app function for this role." }, 400);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "custom-role";
  const slug = `custom-${base}-${randomBytes(3).toString("hex")}`;
  const rows = await db("admin_role_definitions", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ slug, name, description: String(body.description || "").trim().slice(0, 240) || null, permissions, is_system: false, active: true, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, role: rows?.[0] || null });
}

async function updateAdminRole(body) {
  const role = await getRoleDefinition(body.slug);
  if (!role) return reply({ error: "Admin role not found." }, 404);
  const name = String(body.name || "").trim();
  const permissions = role.slug === "owner" ? [...ADMIN_PERMISSIONS.owner] : cleanRolePermissions(body.permissions);
  if (name.length < 2 || name.length > 60) return reply({ error: "Role name must be between 2 and 60 characters." }, 400);
  if (!permissions.length) return reply({ error: "Choose at least one app function for this role." }, 400);
  await db(`admin_role_definitions?slug=eq.${encodeURIComponent(role.slug)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ name, description: String(body.description || "").trim().slice(0, 240) || null, permissions, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function deleteAdminRole(body) {
  const role = await getRoleDefinition(body.slug);
  if (!role) return reply({ error: "Admin role not found." }, 404);
  await db(`admin_role_definitions?slug=eq.${encodeURIComponent(role.slug)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  await db(`admin_roles?role=eq.${encodeURIComponent(role.slug)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function revertAudit(body) {
  if (!body.auditId) return reply({ error: "Audit entry not found." }, 404);
  const logs = await db(`audit_logs?id=eq.${encodeURIComponent(body.auditId)}&select=*`);
  const log = logs?.[0];
  if (!log?.before_data || !log.target_id) return reply({ error: "This action does not have a reversible snapshot." }, 409);
  const tableByTarget = { event: "events", match_score: "match_scores", player: "players", tournament: "tournaments", announcement: "announcements" };
  const table = tableByTarget[log.target_type];
  if (!table) return reply({ error: "This action type cannot be reverted automatically." }, 409);
  const { id, ...before } = log.before_data;
  delete before.created_at;
  await db(`${table}?id=eq.${encodeURIComponent(log.target_id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(before) });
  await db(`audit_logs?id=eq.${encodeURIComponent(body.auditId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ reverted_at: new Date().toISOString() }) });
  return reply({ ok: true });
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
      const existingWaitlist = await db(`event_waitlist?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=*`);
      if (!existingWaitlist?.[0] || existingWaitlist[0].status !== "pending") {
        const positionRows = await db(`event_waitlist?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.pending&select=position&order=position.desc&limit=1`);
        const position = Number(positionRows?.[0]?.position || 0) + 1;
        await db("event_waitlist?on_conflict=event_id,player_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, position, status: "pending", updated_at: new Date().toISOString() }),
        });
        return reply({ ok: true, waitlisted: true, position });
      }
      return reply({ ok: true, waitlisted: true, position: existingWaitlist[0].position });
    }
  } else if (now.getTime() >= oldEoiDeadline(event)) {
    return reply({ error: "The EOI deadline has passed." }, 409);
  }
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, status: body.status, updated_at: new Date().toISOString() }),
  });
  if (body.status === "no") {
    await db(`event_waitlist?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&status=eq.pending`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "removed", updated_at: new Date().toISOString() }),
    });
  }
  await promoteWaitlist(body.eventId);
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

async function updateLiveScoreRow(row, body, patch) {
  const hasRevision = row.revision !== undefined && row.revision !== null;
  const expected = hasRevision && Number.isFinite(Number(body.expectedRevision)) ? `&revision=eq.${encodeURIComponent(Number(body.expectedRevision))}` : "";
  const rows = await db(`match_scores?id=eq.${encodeURIComponent(row.id)}${expected}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (hasRevision && (!Array.isArray(rows) || !rows.length)) return reply({ error: "This live board changed on another device. Refresh the score before adding the next point." }, 409);
  return null;
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
  if (body.clientActionId) {
    const receipts = await db(`score_action_receipts?client_action_id=eq.${encodeURIComponent(body.clientActionId)}&select=client_action_id`);
    if (receipts?.[0]) return reply({ ok: true, replayed: true });
  }
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
    const conflict = await updateLiveScoreRow(row, body, { target_points: target, best_of: bestOf, server_player_id: serverId || null, server_team: serverTeam || null, server_position: body.serverPosition === "left" ? "left" : "right", updated_at: new Date().toISOString() });
    if (conflict) return conflict;
    await recordScoreAction(body);
    return reply({ ok: true });
  }
  if (action === "start") {
    const conflict = await updateLiveScoreRow(row, body, { status: "live", submitted_by: row.submitted_by || body.playerId, started_at: row.started_at || new Date().toISOString(), updated_at: new Date().toISOString() });
    if (conflict) return conflict;
    await recordScoreAction(body);
    return reply({ ok: true });
  }
  if (action === "undo") {
    const history = Array.isArray(row.score_history) ? [...row.score_history] : [];
    const previous = history.pop();
    if (!previous) return reply({ error: "There is no score to undo." }, 409);
    const conflict = await updateLiveScoreRow(row, body, { ...previous, score_history: history, updated_at: new Date().toISOString() });
    if (conflict) return conflict;
    await recordScoreAction(body);
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
  const conflict = await updateLiveScoreRow(row, body, patch);
  if (conflict) return conflict;
  await recordScoreAction(body);
  return reply({ ok: true, completed: patch.status === "completed" });
}

async function recordScoreAction(body) {
  if (!body.clientActionId) return;
  await db("score_action_receipts", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ client_action_id: String(body.clientActionId), score_id: body.scoreId, player_id: body.playerId, action: body.action }),
  });
}

async function adminLogin(body, req) {
  if (body.playerId && body.playerPin) {
    const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id,name,pin_hash`);
    const role = await assignedAdminRole(body.playerId);
    const validRole = Boolean(role);
    if (!players?.[0]?.pin_hash || !verifyPasscode(String(body.playerPin), players[0].pin_hash) || !role || !validRole) return reply({ error: "Admin player PIN or role is incorrect." }, 401);
    body.__adminActorId = String(body.playerId);
    body.__adminRole = role;
    body.__adminIdentity = "player-pin";
    return reply({ ok: true, role, token: signAdminSession(role, body.playerId) });
  }
  if (!/^\d{4,8}$/.test(body.passcode || "")) return reply({ error: "Invalid passcode." }, 401);
  let stored = await getPasscodeSetting();
  if (!stored && body.passcode === INITIAL_PASSCODE) {
    await savePasscode(body.passcode);
    stored = await getPasscodeSetting();
  }
  if (!verifyPasscode(body.passcode, stored)) return reply({ error: "Incorrect passcode." }, 401);
  body.__adminActorId = playerSession(req)?.playerId || (body.playerId && req && isPlayer(req, body.playerId) ? String(body.playerId) : null);
  body.__adminRole = "owner";
  body.__adminIdentity = "shared-passcode";
  return reply({ ok: true, role: "owner", token: signAdminSession("owner", body.__adminActorId) });
}

async function changePasscode(body) {
  const stored = await getPasscodeSetting();
  if (!verifyPasscode(body.currentPasscode || "", stored)) return reply({ error: "Current passcode is incorrect." }, 401);
  if (!/^\d{4,8}$/.test(body.newPasscode || "")) return reply({ error: "Use 4–8 numbers." }, 400);
  await savePasscode(body.newPasscode);
  return reply({ ok: true, token: signSession() });
}

async function saveEvent(body) {
  const existing = await getEvent(body.eventId);
  if (!existing) return reply({ error: "Event not found." }, 404);
  const allowed = ["event_date", "start_time", "end_time", "location", "suburb", "location_id", "court_1_name", "court_fee", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_2_fee", "court_3_enabled", "court_3_name", "court_3_start_time", "court_3_end_time", "court_3_fee", "shuttle_fee", "account_closed"];
  const update = Object.fromEntries(Object.entries(body.changes || {}).filter(([key]) => allowed.includes(key)));
  const proposed = { ...existing, ...update };
  const locationChanged = ["location", "suburb", "location_id"].some(key => key in update);
  const explicitLocationId = "location_id" in update ? update.location_id : null;
  const inferredLocationId = explicitLocationId || locationIdForValues(proposed.location, proposed.suburb, locationChanged ? null : existing.location_id);
  if (["location", "suburb", "location_id"].some(key => key in update)) update.location_id = inferredLocationId;
  for (const [feeKey, manualKey] of [["court_fee", "court_fee_manual"], ["court_2_fee", "court_2_fee_manual"], ["court_3_fee", "court_3_fee_manual"]]) {
    if (feeKey in update && Number(update[feeKey]) !== Number(existing[feeKey])) update[manualKey] = true;
  }
  const nextEvent = { ...existing, ...update };
  const pricingInputsChanged = ["event_date", "start_time", "end_time", "location", "suburb", "location_id", "court_2_enabled", "court_2_start_time", "court_2_end_time", "court_3_enabled", "court_3_start_time", "court_3_end_time"].some(key => key in update);
  if (pricingInputsChanged && nextEvent.location_id) {
    const fees = automaticCourtFees(nextEvent, await locationRates(nextEvent.location_id));
    if (fees) {
      update.court_fee = fees.court_fee;
      update.court_2_fee = fees.court_2_fee;
      update.court_3_fee = fees.court_3_fee;
      update.court_fee_manual = false;
      update.court_2_fee_manual = false;
      update.court_3_fee_manual = false;
    }
  }
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

async function savePairing(body, req) {
  const eventId = String(body.eventId || "");
  const playerId = String(body.playerId || "");
  const pairings = Array.isArray(body.pairings) ? body.pairings.map(pair => Array.isArray(pair) ? pair.filter(Boolean) : []) : [];
  const adminRequest = isAdmin(req);
  if (!eventId || (!playerId && !adminRequest) || !pairings.length) return reply({ error: "Add the complete pairing set before saving." }, 400);
  const event = await getEvent(eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (adminRequest) {
    if (!await hasAdminPermission(req, "schedule")) return reply({ error: "Your admin role does not have permission to edit pairings." }, 403);
  } else if (!attending.has(playerId)) return reply({ error: "Only attendees can edit the pairings." }, 403);
  if (pairings.some(pair => pair.length !== 2 || new Set(pair).size !== 2)) return reply({ error: "Each pairing needs two different players." }, 400);
  const allPlayers = pairings.flat();
  if (allPlayers.some(id => !attending.has(id))) return reply({ error: "Choose players marked In for this session." }, 400);
  if (new Set(allPlayers).size !== allPlayers.length) return reply({ error: "Each attendee can only appear in one pairing. Make all changes, then save the full set." }, 400);
  await saveEventPairings(eventId, pairings);
  const schedule = await generateEventSchedule(eventId, { force: true });
  const scores = await db(`match_scores?event_id=eq.${encodeURIComponent(eventId)}&select=*&order=match_number.asc`);
  return reply({ ok: true, updated: pairings.length, pairings, scores, scheduleUpdated: schedule.saved });
}

function randomPairings(playerIds, previousPairings = []) {
  const ids = [...playerIds];
  const previous = new Set(previousPairings.map(pair => [...pair].sort().join(":")));
  let best = null;
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const shuffled = [...ids];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    const pairings = [];
    for (let index = 0; index < shuffled.length; index += 2) pairings.push([shuffled[index], shuffled[index + 1]]);
    const overlap = pairings.filter(pair => previous.has([...pair].sort().join(":"))).length;
    if (overlap < bestOverlap) {
      best = pairings;
      bestOverlap = overlap;
    }
    if (overlap === 0) break;
  }
  return best;
}

async function rebuildPairings(body, req) {
  const eventId = String(body.eventId || "");
  const playerId = String(body.playerId || "");
  const adminRequest = isAdmin(req);
  if (!eventId || (!playerId && !adminRequest)) return reply({ error: "Choose a session and sign in first." }, 400);
  const event = await getEvent(eventId);
  if (!event) return reply({ error: "Event not found." }, 404);

  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  const attendingIds = attendingRows.map(row => row.player_id).filter(Boolean);
  if (attendingIds.length < 4 || attendingIds.length % 2 !== 0) {
    return reply({ error: "Pairings need an even number of at least four players marked In." }, 400);
  }

  if (adminRequest) {
    if (!await hasAdminPermission(req, "schedule")) return reply({ error: "Your admin role does not have permission to rebuild pairings." }, 403);
  } else if (!attendingIds.includes(playerId)) {
    return reply({ error: "Only attendees can rebuild the pairings." }, 403);
  }

  const existing = await db(`match_scores?event_id=eq.${encodeURIComponent(eventId)}&select=team_a_player_ids,team_b_player_ids`);
  const previous = existing.flatMap(row => [row.team_a_player_ids, row.team_b_player_ids]).filter(pair => Array.isArray(pair) && pair.length === 2);
  const pairings = randomPairings(attendingIds, previous);
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
  await db(`players?guest_event_id=eq.${encodeURIComponent(body.eventId)}&is_guest=eq.true`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function addPlayer(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 80) return reply({ error: "Enter a valid player name." }, 400);
  const rows = await db("players?on_conflict=name", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ name, active: true }),
  });
  const player = rows?.[0];
  return reply({ ok: true, player: player ? { id: player.id, name: player.name, active: player.active, has_pin: Boolean(player.pin_hash) } : null });
}

async function addGuest(body) {
  const eventId = String(body.eventId || "").trim();
  const rawName = String(body.name || "").replace(/\s*\(guest\)\s*$/i, "").trim();
  if (!eventId || rawName.length < 2 || rawName.length > 70) return reply({ error: "Enter a valid guest name and choose a session." }, 400);
  const event = await getEvent(eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const hours = Number(body.hoursPlayed || eventDurationHours(event));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8) return reply({ error: "Enter guest hours between 0 and 8." }, 400);
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  if (attendingRows.length >= eventCapacity(event)) return reply({ error: `This session is full at ${eventCapacity(event)} players.` }, 409);
  const displayName = `${rawName} (Guest)`;
  const existing = await db(`players?name=eq.${encodeURIComponent(displayName)}&select=id,name,active,is_guest,guest_event_id,pin_hash`);
  if (existing?.[0]) {
    if (existing[0].guest_event_id !== eventId) return reply({ error: "A guest with that name already exists. Use a different label for this session." }, 409);
    await db(`players?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ active: true, is_guest: true, guest_event_id: eventId, pin_hash: null }),
    });
    await db("eois?on_conflict=event_id,player_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ event_id: eventId, player_id: existing[0].id, status: "yes", locked_in: true, locked_at: new Date().toISOString(), penalty_amount: 0, updated_at: new Date().toISOString() }),
    });
    await db("event_player_hours?on_conflict=event_id,player_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ event_id: eventId, player_id: existing[0].id, hours_played: hours, updated_at: new Date().toISOString() }),
    });
    await generateEventSchedule(eventId, { force: true });
    return reply({ ok: true, guest: { id: existing[0].id, name: displayName, is_guest: true } });
  }
  let rows;
  try {
    rows = await db("players", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name: displayName, active: true, is_guest: true, guest_event_id: eventId }),
    });
  } catch (error) {
    if (String(error.message).includes("duplicate key")) return reply({ error: "A player or guest with that name already exists." }, 409);
    throw error;
  }
  const guest = rows?.[0];
  if (!guest) return reply({ error: "Guest could not be created." }, 500);
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: eventId, player_id: guest.id, status: "yes", locked_in: true, locked_at: new Date().toISOString(), penalty_amount: 0, updated_at: new Date().toISOString() }),
  });
  await db("event_player_hours?on_conflict=event_id,player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: eventId, player_id: guest.id, hours_played: hours, updated_at: new Date().toISOString() }),
  });
  await generateEventSchedule(eventId, { force: true });
  return reply({ ok: true, guest: { id: guest.id, name: displayName, is_guest: true } });
}

async function removeGuest(body) {
  const eventId = String(body.eventId || "").trim();
  const playerId = String(body.playerId || "").trim();
  if (!eventId || !playerId) return reply({ error: "Guest or event not found." }, 400);
  const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&guest_event_id=eq.${encodeURIComponent(eventId)}&is_guest=eq.true&select=id,name`);
  if (!rows?.[0]) return reply({ error: "Guest not found for this session." }, 404);
  await Promise.all([
    db(`eois?event_id=eq.${encodeURIComponent(eventId)}&player_id=eq.${encodeURIComponent(playerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }),
    db(`payments?event_id=eq.${encodeURIComponent(eventId)}&player_id=eq.${encodeURIComponent(playerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }),
    db(`event_player_hours?event_id=eq.${encodeURIComponent(eventId)}&player_id=eq.${encodeURIComponent(playerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }),
    db(`players?id=eq.${encodeURIComponent(playerId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }) }),
  ]);
  await generateEventSchedule(eventId, { force: true });
  return reply({ ok: true });
}

async function playerPin(body) {
  const playerId = String(body.playerId || "").trim();
  const pin = String(body.pin || "").trim();
  if (!playerId || !/^(?:\d{4}|\d{6})$/.test(pin)) return reply({ error: "PIN must be exactly 4 or 6 digits." }, 400);
  const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&select=id,name,active,pin_hash`);
  const player = rows?.[0];
  if (!player?.active) return reply({ error: "Player not found." }, 404);
  if (player.pin_hash) {
    if (!verifyPasscode(pin, player.pin_hash)) return reply({ error: "Incorrect PIN." }, 401);
  } else {
    if (body.mode !== "set") return reply({ error: "Set a PIN to finish your first login." }, 409);
    await db(`players?id=eq.${encodeURIComponent(playerId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pin_hash: passcodeHash(pin) }),
    });
  }
  const role = await assignedAdminRole(player.id);
  return reply({
    ok: true,
    token: signPlayerSession(player.id),
    adminToken: role ? signAdminSession(role, player.id) : null,
    adminRole: role,
    player: { id: player.id, name: player.name, active: player.active, has_pin: true },
  });
}

async function assignedAdminRole(playerId) {
  const roles = await db(`admin_roles?player_id=eq.${encodeURIComponent(String(playerId))}&active=eq.true&select=role`);
  const role = roles?.[0]?.role;
  const definition = await getRoleDefinition(role);
  if (definition) return definition.active ? role : null;
  return role === "owner" ? role : null;
}

async function playerAdminSession(req) {
  const session = playerSession(req);
  if (!session?.playerId) return reply({ admin: false, role: null, token: null });
  const role = await assignedAdminRole(session.playerId);
  return reply({ admin: Boolean(role), role, token: role ? signAdminSession(role, session.playerId) : null });
}

async function pushConfig() {
  return reply({ enabled: configurePush(), publicKey: VAPID_PUBLIC_KEY || null, supabaseUrl: SUPABASE_URL || null, supabaseAnonKey: SUPABASE_ANON_KEY || null });
}

async function pushStatus(body) {
  const playerId = String(body.playerId || "").trim();
  if (!playerId) return reply({ configured: configurePush(), subscribed: false, deviceCount: 0, lastSeenAt: null });
  const endpoint = String(body.endpoint || "").trim();
  const endpointFilter = endpoint ? `&endpoint=eq.${encodeURIComponent(endpoint)}` : "";
  const rows = await db(`push_subscriptions?player_id=eq.${encodeURIComponent(playerId)}${endpointFilter}&select=id,last_seen_at&order=last_seen_at.desc`);
  return reply({ configured: configurePush(), subscribed: Boolean(rows?.length), deviceCount: rows?.length || 0, lastSeenAt: rows?.[0]?.last_seen_at || null });
}

async function savePushSubscription(body) {
  if (!configurePush()) return reply({ error: "Push notifications are not configured yet." }, 503);
  const subscription = body.subscription && typeof body.subscription === "object" ? body.subscription : {};
  const endpoint = String(subscription.endpoint || "").trim();
  const p256dh = String(subscription.keys?.p256dh || "").trim();
  const auth = String(subscription.keys?.auth || "").trim();
  if (!body.playerId || !endpoint.startsWith("https://") || !p256dh || !auth) return reply({ error: "Invalid push subscription." }, 400);
  await db("push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      player_id: body.playerId,
      endpoint,
      p256dh,
      auth,
      user_agent: String(body.userAgent || "").slice(0, 500) || null,
      last_seen_at: new Date().toISOString(),
    }),
  });
  return reply({ ok: true });
}

async function removePushSubscription(body) {
  const endpoint = String(body.endpoint || "").trim();
  if (!body.playerId || !endpoint) return reply({ error: "Invalid push subscription." }, 400);
  await db(`push_subscriptions?player_id=eq.${encodeURIComponent(body.playerId)}&endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function saveNotificationPreferences(body) {
  if (!body.playerId) return reply({ error: "Player not found." }, 400);
  const booleanKey = ["eoiReminders", "scheduleChanges", "paymentReminders", "announcements", "tournamentUpdates"];
  const update = { player_id: body.playerId, updated_at: new Date().toISOString() };
  for (const key of booleanKey) {
    if (body[key] !== undefined) update[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = Boolean(body[key]);
  }
  for (const key of ["quietHoursStart", "quietHoursEnd"]) {
    if (body[key] !== undefined) update[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = body[key] || null;
  }
  await db("player_notification_preferences?on_conflict=player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(update),
  });
  return reply({ ok: true });
}

async function markAnnouncementRead(body) {
  if (!body.playerId || !body.announcementId) return reply({ error: "Announcement not found." }, 400);
  await db("announcement_reads?on_conflict=announcement_id,player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ announcement_id: body.announcementId, player_id: body.playerId, read_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function sendAnnouncementPush(announcement, targetPlayerIds = null) {
  if (!configurePush()) return { configured: false, sent: 0, failed: 0, skipped: 0 };
  try {
    const [subscriptions, preferences] = await Promise.all([
      db("push_subscriptions?select=id,player_id,endpoint,p256dh,auth"),
      db("player_notification_preferences?select=player_id,announcements"),
    ]);
    const announcementsEnabled = new Map((preferences || []).map((row) => [row.player_id, row.announcements !== false]));
    const target = targetPlayerIds ? new Set(targetPlayerIds.map(String)) : null;
    const eligible = (subscriptions || []).filter((subscription) => {
      if (target) return target.has(String(subscription.player_id));
      return announcementsEnabled.get(subscription.player_id) !== false;
    });
    const payload = JSON.stringify({
      title: announcement.title,
      body: announcement.body,
      tag: `kingsmen-announcement-${announcement.id}`,
      url: "/?page=play",
      announcementId: announcement.id,
      kind: announcement.kind,
      urgent: Boolean(announcement.urgent),
    });
    let sent = 0;
    let failed = 0;
    await Promise.all(eligible.map(async (subscription) => {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, payload);
        sent += 1;
        await db("push_delivery_log", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ player_id: subscription.player_id, announcement_id: announcement.id, kind: announcement.kind || "announcement", succeeded: true }),
        }).catch((logError) => console.error("Push delivery success log failed", logError.message));
      } catch (error) {
        failed += 1;
        await db("push_delivery_log", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ player_id: subscription.player_id, announcement_id: announcement.id, kind: announcement.kind || "announcement", succeeded: false, error_message: String(error.message || error).slice(0, 500) }),
        }).catch((logError) => console.error("Push delivery failure log failed", logError.message));
        if (error.statusCode === 404 || error.statusCode === 410) {
          try {
            await db(`push_subscriptions?id=eq.${encodeURIComponent(subscription.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          } catch (deleteError) {
            console.error("Expired push subscription cleanup failed", deleteError.message);
          }
        } else {
          console.error("Announcement push failed", error.message);
        }
      }
    }));
    return { configured: true, sent, failed, skipped: (subscriptions || []).length - eligible.length, targetCount: target?.size || null };
  } catch (error) {
    console.error("Announcement push lookup failed", error);
    return { configured: true, sent: 0, failed: 1, skipped: 0 };
  }
}

async function createAnnouncement(body) {
  const title = String(body.title || "").trim();
  const message = String(body.body || "").trim();
  if (title.length < 2 || message.length < 2) return reply({ error: "Add a title and message." }, 400);
  const kind = ["announcement", "message", "alert"].includes(body.kind) ? body.kind : "announcement";
  const urgent = Boolean(body.urgent);
  const eventId = urgent ? String(body.eventId || "").trim() : null;
  if (urgent && kind !== "alert") return reply({ error: "Urgent attendee alerts must use the Alert type." }, 400);
  if (urgent && !eventId) return reply({ error: "Choose the session this urgent alert is for." }, 400);
  let targetPlayerIds = null;
  if (urgent) {
    const eventRows = await db(`events?id=eq.${encodeURIComponent(eventId)}&select=id`);
    if (!eventRows?.[0]) return reply({ error: "That session could not be found." }, 404);
    const attendees = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
    targetPlayerIds = attendees.map((row) => row.player_id);
  }
  const rows = await db("announcements", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ title: title.slice(0, 160), body: message.slice(0, 5000), kind, pinned: Boolean(body.pinned) || urgent, urgent, audience: urgent ? "attendees" : "all", event_id: eventId, created_by: body.playerId || null }),
  });
  const announcement = rows?.[0] || null;
  const delivery = kind === "alert" && announcement
    ? await sendAnnouncementPush(announcement, targetPlayerIds)
    : { configured: false, sent: 0, failed: 0, skipped: 0, targetCount: targetPlayerIds?.length || null };
  body.targetPlayerCount = targetPlayerIds?.length || 0;
  body.__pushDelivery = delivery;
  return reply({ ok: true, announcement, delivery });
}

async function updateAnnouncement(body) {
  if (!body.announcementId) return reply({ error: "Announcement not found." }, 404);
  const update = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) update.title = String(body.title).trim().slice(0, 160);
  if (body.body !== undefined) update.body = String(body.body).trim().slice(0, 5000);
  if (body.kind !== undefined && ["announcement", "message", "alert"].includes(body.kind)) update.kind = body.kind;
  if (body.pinned !== undefined) update.pinned = Boolean(body.pinned);
  if (body.urgent !== undefined) update.urgent = Boolean(body.urgent);
  if (body.audience !== undefined && ["all", "attendees"].includes(body.audience)) update.audience = body.audience;
  if (body.eventId !== undefined) update.event_id = String(body.eventId || "").trim() || null;
  await db(`announcements?id=eq.${encodeURIComponent(body.announcementId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update) });
  return reply({ ok: true });
}

async function deleteAnnouncement(body) {
  if (!body.announcementId) return reply({ error: "Announcement not found." }, 404);
  await db(`announcements?id=eq.${encodeURIComponent(body.announcementId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return reply({ ok: true });
}

async function registerTournament(body) {
  if (!body.playerId || !body.tournamentId) return reply({ error: "Tournament or player not found." }, 400);
  const tournaments = await db(`tournaments?id=eq.${encodeURIComponent(body.tournamentId)}&select=*`);
  const tournament = tournaments?.[0];
  if (!tournament) return reply({ error: "Tournament not found." }, 404);
  if (!["draft", "registration_open"].includes(tournament.status)) return reply({ error: "Registration is closed." }, 409);
  const existing = await db(`tournament_entries?tournament_id=eq.${encodeURIComponent(body.tournamentId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=*`);
  if (existing?.[0]?.status === "registered") return reply({ ok: true, entry: existing[0] });
  const activeEntries = await db(`tournament_entries?tournament_id=eq.${encodeURIComponent(body.tournamentId)}&status=eq.registered&select=id`);
  const full = tournament.max_entries && activeEntries.length >= tournament.max_entries;
  const rows = await db("tournament_entries?on_conflict=tournament_id,player_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ tournament_id: body.tournamentId, player_id: body.playerId, partner_player_id: body.partnerPlayerId || null, status: full ? "waitlisted" : "registered", updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, waitlisted: full, entry: rows?.[0] || null });
}

function addMinutesToTime(time, minutes) {
  const [hours, mins] = String(time || "09:00").split(":").map(Number);
  const total = hours * 60 + mins + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function stageSlug(value, fallback) {
  const slug = String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || fallback;
}

function defaultTournamentStages(tournament = {}) {
  return [{
    id: "main-stage",
    name: "Main stage",
    type: "groups",
    tier: "main",
    pointCap: Number(tournament.point_cap || 21),
    pointDifferential: Number(tournament.point_differential ?? 2),
    bestOf: Number(tournament.best_of || 1),
    groupCount: 1,
    teamsPerGroup: Number(tournament.max_entries || 0) || null,
    qualificationRules: [],
    bracketSize: 0,
    bracketMatches: [],
  }];
}

function normaliseTournamentStages(value, tournament = {}) {
  const source = Array.isArray(value) && value.length ? value : defaultTournamentStages(tournament);
  const used = new Set();
  const number = (raw, fallback, min, max) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  };
  return source.slice(0, 64).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const base = stageSlug(item.id || item.name, `stage-${index + 1}`);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    const type = item.type === "knockout" ? "knockout" : "groups";
    const tier = ["group", "cup", "plate", "main", "custom"].includes(item.tier) ? item.tier : type === "groups" ? "group" : "custom";
    const qualificationRules = Array.isArray(item.qualificationRules) ? item.qualificationRules.slice(0, 32).map((rule) => ({
      from: number(rule?.from, 1, 1, 1000),
      to: number(rule?.to, number(rule?.from, 1, 1, 1000), 1, 1000),
      destinationStage: String(rule?.destinationStage || "").trim().slice(0, 64),
      path: String(rule?.path || "").trim().slice(0, 160),
    })) : [];
    const bracketMatches = Array.isArray(item.bracketMatches) ? item.bracketMatches.slice(0, 256).map((match, matchIndex) => ({
      matchNumber: number(match?.matchNumber, matchIndex + 1, 1, 1000),
      sourceA: String(match?.sourceA || "").trim().slice(0, 160),
      sourceB: String(match?.sourceB || "").trim().slice(0, 160),
      nextStageKey: stageSlug(match?.nextStageKey || "", ""),
      nextMatchNumber: match?.nextMatchNumber ? number(match.nextMatchNumber, 1, 1, 1000) : null,
    })) : [];
    return {
      id,
      name: String(item.name || `Stage ${index + 1}`).trim().slice(0, 100) || `Stage ${index + 1}`,
      type,
      tier,
      pointCap: number(item.pointCap, number(tournament.point_cap, 21, 1, 30), 1, 30),
      pointDifferential: number(item.pointDifferential, number(tournament.point_differential, 2, 0, 10), 0, 10),
      bestOf: [1, 3].includes(Number(item.bestOf)) ? Number(item.bestOf) : number(tournament.best_of, 1, 1, 3) === 3 ? 3 : 1,
      groupCount: number(item.groupCount, 1, 1, 64),
      teamsPerGroup: item.teamsPerGroup ? number(item.teamsPerGroup, 1, 1, 1000) : null,
      qualificationRules,
      bracketSize: type === "knockout" ? number(item.bracketSize, Math.max(2, bracketMatches.length * 2), 2, 1000) : 0,
      bracketMatches,
    };
  });
}

async function generateTournamentDraw(body) {
  if (!body.tournamentId) return reply({ error: "Tournament not found." }, 404);
  const tournaments = await db(`tournaments?id=eq.${encodeURIComponent(body.tournamentId)}&select=*`);
  const tournament = tournaments?.[0];
  if (!tournament) return reply({ error: "Tournament not found." }, 404);
  const entries = await db(`tournament_entries?tournament_id=eq.${encodeURIComponent(body.tournamentId)}&status=eq.registered&order=seed.asc,created_at.asc&select=*`);
  if (entries.length < 2) return reply({ error: "Register at least two entries before generating a draw." }, 400);
  await db(`tournament_matches?tournament_id=eq.${encodeURIComponent(body.tournamentId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  const matches = [];
  let matchNumber = 1;
  const start = tournament.start_time || "09:00";
  const stages = normaliseTournamentStages(tournament.stage_config, tournament);
  const courtCount = Math.max(1, Number(tournament.court_count || 1));
  const slotMinutes = Number(tournament.match_minutes || 12) + Number(tournament.changeover_minutes || 1);
  const addMatch = (stage, extra = {}) => {
    const slot = matches.length;
    const courtIndex = slot % courtCount;
    const roundIndex = Math.floor(slot / courtCount);
    const startAt = addMinutesToTime(start, roundIndex * slotMinutes);
    matches.push({
      tournament_id: body.tournamentId,
      round: extra.round || 1,
      match_number: matchNumber++,
      court_name: `Court ${courtIndex + 1}`,
      scheduled_start: startAt,
      scheduled_end: addMinutesToTime(startAt, Number(tournament.match_minutes || 12)),
      team_a_entry_ids: extra.teamA || [],
      team_b_entry_ids: extra.teamB || [],
      target_points: stage.pointCap,
      point_differential: stage.pointDifferential,
      best_of: stage.bestOf,
      stage_key: stage.id,
      stage_name: stage.name,
      stage_type: stage.type,
      stage_tier: stage.tier,
      stage_match_number: extra.stageMatchNumber || null,
      group_number: extra.groupNumber || null,
      source_a: extra.sourceA || null,
      source_b: extra.sourceB || null,
      next_stage_key: extra.nextStageKey || null,
      next_match_number: extra.nextMatchNumber || null,
    });
  };
  for (const stage of stages) {
    let stageMatchNumber = 0;
    if (stage.type === "groups") {
      const groupCount = Math.max(1, stage.groupCount || 1);
      const groups = Array.from({ length: groupCount }, () => []);
      entries.forEach((entry, index) => groups[index % groupCount].push(entry));
      groups.forEach((group, groupIndex) => {
        for (let left = 0; left < group.length; left += 1) {
          for (let right = left + 1; right < group.length; right += 1) {
            stageMatchNumber += 1;
            addMatch(stage, { teamA: [group[left].id], teamB: [group[right].id], groupNumber: groupIndex + 1, stageMatchNumber });
          }
        }
      });
      continue;
    }
    const bracketMatches = stage.bracketMatches.length ? stage.bracketMatches : Array.from({ length: Math.max(1, Math.ceil(stage.bracketSize / 2)) }, (_, index) => ({ matchNumber: index + 1, sourceA: `Slot ${index * 2 + 1}`, sourceB: `Slot ${index * 2 + 2}` }));
    bracketMatches.forEach((bracket) => addMatch(stage, {
      sourceA: bracket.sourceA,
      sourceB: bracket.sourceB,
      stageMatchNumber: bracket.matchNumber,
      nextStageKey: bracket.nextStageKey,
      nextMatchNumber: bracket.nextMatchNumber,
    }));
  }
  const rows = await db("tournament_matches", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(matches) });
  await db(`tournaments?id=eq.${encodeURIComponent(body.tournamentId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ stage_config: stages, status: "in_progress", updated_at: new Date().toISOString() }) });
  return reply({ ok: true, matches: rows || [] });
}

async function saveTournamentMatch(body) {
  if (!body.matchId) return reply({ error: "Tournament match not found." }, 404);
  const matchRows = await db(`tournament_matches?id=eq.${encodeURIComponent(body.matchId)}&select=*`);
  const match = matchRows?.[0];
  if (!match) return reply({ error: "Tournament match not found." }, 404);
  const gamesA = Number(body.gamesA), gamesB = Number(body.gamesB);
  if (!Number.isInteger(gamesA) || !Number.isInteger(gamesB) || gamesA < 0 || gamesB < 0 || gamesA === gamesB) return reply({ error: "Enter a winning tournament result." }, 400);
  await db(`tournament_matches?id=eq.${encodeURIComponent(body.matchId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ games_a: gamesA, games_b: gamesB, game_scores: Array.isArray(body.gameScores) ? body.gameScores : [], status: "completed", updated_at: new Date().toISOString() }) });
  await resolveTournamentBracket(match.tournament_id);
  return reply({ ok: true });
}

async function resolveTournamentBracket(tournamentId) {
  const rows = await db(`tournament_matches?tournament_id=eq.${encodeURIComponent(tournamentId)}&select=*`);
  if (!Array.isArray(rows) || !rows.length) return;
  const updates = new Map();
  const setTeam = (row, side, ids) => {
    const key = row.id;
    const next = updates.get(key) || {};
    const field = side === "a" ? "team_a_entry_ids" : "team_b_entry_ids";
    if (JSON.stringify(row[field] || []) !== JSON.stringify(ids || [])) next[field] = ids || [];
    updates.set(key, next);
  };
  const stageMatch = (row) => Number(row.stage_match_number || row.match_number || 0);
  const winnerIds = (row) => Number(row.games_a) > Number(row.games_b) ? (row.team_a_entry_ids || []) : Number(row.games_b) > Number(row.games_a) ? (row.team_b_entry_ids || []) : [];
  const targetFor = (row) => rows.find((candidate) => candidate.stage_key === row.next_stage_key && stageMatch(candidate) === Number(row.next_match_number));
  rows.filter((row) => row.status === "completed" && row.next_stage_key && row.next_match_number).forEach((row) => {
    const target = targetFor(row);
    const winner = winnerIds(row);
    if (!target || !winner.length) return;
    const source = `${row.stage_name || row.stage_key || "Stage"} M${stageMatch(row)} winner`;
    if (target.source_a === source) setTeam(target, "a", winner);
    if (target.source_b === source) setTeam(target, "b", winner);
  });
  const allGroupRows = rows.filter((row) => row.stage_type === "groups" && row.group_number);
  const groupCounts = new Map();
  const completedGroupCounts = new Map();
  allGroupRows.forEach((row) => {
    const group = Number(row.group_number);
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
    if (row.status === "completed") completedGroupCounts.set(group, (completedGroupCounts.get(group) || 0) + 1);
  });
  const readyGroups = new Set([...groupCounts.keys()].filter((group) => groupCounts.get(group) > 0 && completedGroupCounts.get(group) === groupCounts.get(group)));
  const groupRows = allGroupRows.filter((row) => row.status === "completed");
  const standings = new Map();
  groupRows.forEach((row) => {
    const group = Number(row.group_number);
    const a = row.team_a_entry_ids?.[0];
    const b = row.team_b_entry_ids?.[0];
    if (!a || !b || Number(row.games_a) === Number(row.games_b)) return;
    const table = standings.get(group) || new Map();
    const ensure = (id) => table.get(id) || { id, wins: 0, diff: 0 };
    const statA = ensure(a); const statB = ensure(b);
    statA.wins += Number(row.games_a) > Number(row.games_b) ? 1 : 0;
    statB.wins += Number(row.games_b) > Number(row.games_a) ? 1 : 0;
    statA.diff += Number(row.games_a) - Number(row.games_b);
    statB.diff += Number(row.games_b) - Number(row.games_a);
    table.set(a, statA); table.set(b, statB); standings.set(group, table);
  });
  const groupStage = rows.find((row) => row.stage_type === "groups");
  if (groupStage && standings.size) {
    rows.filter((row) => row.source_a || row.source_b).forEach((row) => {
      ["a", "b"].forEach((side) => {
        const source = row[`source_${side}`] || "";
        const match = source.match(/^Group\s+(\d+)\s+#(\d+)$/i);
        if (!match) return;
        if (!readyGroups.has(Number(match[1]))) return;
        const table = standings.get(Number(match[1]));
        if (!table) return;
        const ranked = [...table.values()].sort((left, right) => right.wins - left.wins || right.diff - left.diff || String(left.id).localeCompare(String(right.id)));
        const entry = ranked[Number(match[2]) - 1];
        if (entry) setTeam(row, side, [entry.id]);
      });
    });
  }
  await Promise.all([...updates.entries()].filter(([, patch]) => Object.keys(patch).length).map(([id, patch]) => db(`tournament_matches?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) })));
}

async function removePlayer(body) {
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
  return reply({ ok: true });
}

async function resetPlayerPin(body) {
  const playerId = String(body.playerId || "").trim();
  if (!playerId) return reply({ error: "Player not found." }, 400);
  const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&select=id,name,active`);
  if (!rows?.[0]) return reply({ error: "Player not found." }, 404);
  await db(`players?id=eq.${encodeURIComponent(playerId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ pin_hash: null }),
  });
  return reply({ ok: true, player: { ...rows[0], has_pin: false } });
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
  const isGuest = await playerIsGuest(body.playerId);
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
  if (!isGuest && body.status === "no" && body.applyPenalty !== false && current?.status === "yes" && (lockedIn || (isThursdayEvent(event) && new Date() >= thursdayLockAt(event)))) {
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
  await promoteWaitlist(body.eventId);
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

function optionalIsoDate(value, label) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not valid.`);
  return parsed.toISOString();
}

async function createTournament(body) {
  const name = String(body.name || "").trim();
  const tournamentDate = String(body.tournamentDate || "").trim();
  const location = String(body.location || "").trim();
  if (name.length < 3 || name.length > 140) return reply({ error: "Enter a tournament name between 3 and 140 characters." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tournamentDate)) return reply({ error: "Choose a tournament date." }, 400);
  if (!location || location.length > 140) return reply({ error: "Enter a tournament location." }, 400);
  const discipline = ["Singles", "Doubles", "Mixed doubles", "Singles and doubles"].includes(body.discipline) ? body.discipline : "Doubles";
  const competitionFormat = ["Round robin", "Knockout", "Groups and knockout", "Swiss system"].includes(body.competitionFormat) ? body.competitionFormat : "Round robin";
  const status = ["draft", "registration_open", "registration_closed", "in_progress", "completed", "cancelled"].includes(body.status) ? body.status : "draft";
  const number = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  };
  const tournament = {
    name,
    description: String(body.description || "").trim().slice(0, 2000) || null,
    status,
    tournament_type: String(body.tournamentType || "Club tournament").trim().slice(0, 80) || "Club tournament",
    discipline,
    competition_format: competitionFormat,
    tournament_date: tournamentDate,
    start_time: body.startTime || null,
    end_time: body.endTime || null,
    timezone: SYDNEY,
    location_id: String(body.locationId || "").trim() || null,
    location,
    suburb: String(body.suburb || "").trim().slice(0, 100) || null,
    registration_open_at: optionalIsoDate(body.registrationOpenAt, "Registration open time"),
    registration_close_at: optionalIsoDate(body.registrationCloseAt, "Registration close time"),
    payment_due_at: optionalIsoDate(body.paymentDueAt, "Payment due time"),
    max_entries: body.maxEntries ? number(body.maxEntries, null, 1, 1000) : null,
    court_count: number(body.courtCount, 2, 1, 20),
    match_minutes: number(body.matchMinutes, 12, 1, 180),
    changeover_minutes: number(body.changeoverMinutes, 1, 0, 30),
    point_cap: number(body.pointCap, 21, 1, 30),
    point_differential: number(body.pointDifferential, 2, 0, 10),
    best_of: [1, 3].includes(Number(body.bestOf)) ? Number(body.bestOf) : 1,
    stage_config: normaliseTournamentStages(body.stageConfig, { point_cap: body.pointCap, point_differential: body.pointDifferential, best_of: body.bestOf, max_entries: body.maxEntries }),
    entry_fee: number(body.entryFee, 0, 0, 100000),
    shuttle_fee_included: Boolean(body.shuttleFeeIncluded),
    organiser_name: String(body.organiserName || "").trim().slice(0, 120) || null,
    organiser_contact: String(body.organiserContact || "").trim().slice(0, 160) || null,
    prize_details: String(body.prizeDetails || "").trim().slice(0, 2000) || null,
    rules: String(body.rules || "").trim().slice(0, 5000) || null,
    notes: String(body.notes || "").trim().slice(0, 3000) || null,
    updated_at: new Date().toISOString(),
  };
  const rows = await db("tournaments", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(tournament),
  });
  return reply({ ok: true, tournament: rows?.[0] || null });
}

async function updateTournamentStages(body) {
  if (!body.tournamentId) return reply({ error: "Tournament not found." }, 404);
  const rows = await db(`tournaments?id=eq.${encodeURIComponent(body.tournamentId)}&select=*`);
  const tournament = rows?.[0];
  if (!tournament) return reply({ error: "Tournament not found." }, 404);
  const stages = normaliseTournamentStages(body.stageConfig, tournament);
  const updated = await db(`tournaments?id=eq.${encodeURIComponent(body.tournamentId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ stage_config: stages, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, stages, tournament: updated?.[0] || null });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";
    if (req.method === "GET" && action === "health") {
      return reply({ ok: Boolean(SUPABASE_URL && SERVICE_KEY && SESSION_SECRET), appVersion: APP_VERSION, supabaseConfigured: Boolean(SUPABASE_URL && SERVICE_KEY), sessionConfigured: Boolean(SESSION_SECRET), serverNow: new Date().toISOString() });
    }
    requireConfiguration();
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (req.method !== "GET" && contentLength > 2_000_000) return reply({ error: "Request is too large." }, 413);
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));

    if (["admin-login", "player-pin"].includes(action) && !consumeRateLimit(req, action)) {
      return reply({ error: "Too many sign-in attempts. Please wait a few minutes and try again." }, 429, { "retry-after": "600" });
    }

    if (req.method === "GET" && action === "push-config") return pushConfig();
    if (req.method === "GET" && action === "state") return reply(await appState(req));
    if (req.method === "GET" && action === "admin-session") return playerAdminSession(req);
    const playerIdForAction = {
      eoi: body.playerId,
      paid: body.playerId,
      "shuttle-fee": body.playerId,
      score: body.submittedBy,
      "live-score-new": body.playerId,
      "live-score": body.playerId,
      "media-upload-url": body.playerId,
      "media-finalize": body.playerId,
      "save-pairing": body.playerId,
      "rebuild-pairings": body.playerId,
      "push-subscribe": body.playerId,
      "push-status": body.playerId,
      "push-unsubscribe": body.playerId,
      "notification-preferences": body.playerId,
      "announcement-read": body.playerId,
      "tournament-register": body.playerId,
      "view-tab": body.playerId,
    }[action];
    if (req.method === "POST" && playerIdForAction && !isPlayer(req, playerIdForAction) && !isAdmin(req)) {
      return audited(req, action, body, async () => reply({ error: "Player PIN required. Please sign in again." }, 401));
    }
    if (req.method === "POST" && action === "eoi") return audited(req, action, body, () => submitEoi(body));
    if (req.method === "POST" && action === "paid") return audited(req, action, body, () => markPaid(body));
    if (req.method === "POST" && action === "shuttle-fee") return audited(req, action, body, () => updateShuttleFee(body));
    if (req.method === "POST" && action === "score") return audited(req, action, body, () => submitScore(body));
    if (req.method === "POST" && action === "live-score-new") return audited(req, action, body, () => createLiveMatch(body));
    if (req.method === "POST" && action === "live-score") return audited(req, action, body, () => liveScore(body));
    if (req.method === "POST" && action === "media-upload-url") return audited(req, action, body, () => createMediaUpload(body));
    if (req.method === "POST" && action === "media-finalize") return audited(req, action, body, () => finalizeMediaUpload(body));
    if (req.method === "POST" && action === "admin-login") return audited(req, action, body, () => adminLogin(body, req));
    if (req.method === "POST" && action === "add-player") return audited(req, action, body, () => addPlayer(body));
    if (req.method === "POST" && action === "player-pin") return audited(req, action, body, () => playerPin(body));
    if (req.method === "POST" && action === "save-pairing") return audited(req, action, body, () => savePairing(body, req));
    if (req.method === "POST" && action === "rebuild-pairings") return audited(req, action, body, () => rebuildPairings(body, req));
    if (req.method === "POST" && action === "push-status") return audited(req, action, body, () => pushStatus(body));
    if (req.method === "POST" && action === "push-subscribe") return audited(req, action, body, () => savePushSubscription(body));
    if (req.method === "POST" && action === "push-unsubscribe") return audited(req, action, body, () => removePushSubscription(body));
    if (req.method === "POST" && action === "notification-preferences") return audited(req, action, body, () => saveNotificationPreferences(body));
    if (req.method === "POST" && action === "announcement-read") return audited(req, action, body, () => markAnnouncementRead(body));
    if (req.method === "POST" && action === "tournament-register") return audited(req, action, body, () => registerTournament(body));
    if (req.method === "POST" && action === "view-tab") return audited(req, action, body, () => viewPage(body));
    if (req.method === "GET" && action === "score-state") return reply(await scoreState(url.searchParams.get("eventId")));
    if (req.method === "GET" && action === "admin-state") {
      return audited(req, action, body, async () => {
        if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
        return reply(await adminState(req));
      });
    }
    if (req.method === "GET" && action === "admin-role-holders") {
      return reply(await adminRoleHolders());
    }
    if (req.method === "GET" && action === "admin-audit-log") {
      return audited(req, action, body, async () => {
        if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
        return reply(await adminAuditLog({
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          actorId: url.searchParams.get("actorId"),
          action: url.searchParams.get("auditAction"),
          failed: url.searchParams.get("failed"),
        }));
      });
    }
    if (req.method === "GET" && action === "admin-export") {
      return audited(req, action, body, async () => {
        if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
        if (!await hasAdminPermission(req, "audit")) return reply({ error: "Your admin role does not have export permission." }, 403);
        return adminExport();
      });
    }

    if (!["view-tab", "admin-view-tab", "admin-change-passcode", "admin-save-event", "admin-generate-schedule", "admin-save-match", "admin-delete-event", "admin-add-player", "admin-update-player", "admin-remove-player", "admin-reset-player-pin", "admin-set-eoi", "admin-add-guest", "admin-remove-guest", "admin-set-payment", "admin-set-hours", "admin-delete-score", "admin-delete-media", "admin-create-tournament", "admin-update-tournament-stages", "admin-set-role", "admin-create-role", "admin-update-role", "admin-delete-role", "admin-revert-audit", "admin-create-announcement", "admin-update-announcement", "admin-delete-announcement", "admin-generate-tournament-draw", "admin-save-tournament-match"].includes(action)) {
      return reply({ error: "Unknown action." }, 404);
    }
    if (!isAdmin(req)) return audited(req, action, body, async () => reply({ error: "Admin session expired." }, 401));
    if (["admin-change-passcode", "admin-set-role", "admin-create-role", "admin-update-role", "admin-delete-role"].includes(action) && adminRole(req) !== "owner") {
      return audited(req, action, body, async () => reply({ error: "Only the owner can manage admin access." }, 403));
    }
    const permissionForAction = {
      "admin-save-event": "events", "admin-delete-event": "events", "admin-generate-schedule": "schedule", "admin-save-match": "schedule",
      "admin-set-eoi": "eoi", "admin-add-guest": "eoi", "admin-remove-guest": "eoi", "admin-set-payment": "money", "admin-set-hours": "money", "admin-delete-score": "scores", "admin-create-tournament": "tournaments",
      "admin-generate-tournament-draw": "tournaments", "admin-update-tournament-stages": "tournaments", "admin-save-tournament-match": "scores", "admin-create-announcement": "announcements", "admin-update-announcement": "announcements", "admin-delete-announcement": "announcements", "admin-set-role": "roles", "admin-create-role": "roles", "admin-update-role": "roles", "admin-delete-role": "roles", "admin-revert-audit": "audit", "admin-delete-media": "media",
    }[action];
    if (permissionForAction && !await hasAdminPermission(req, permissionForAction)) return audited(req, action, body, async () => reply({ error: "Your admin role does not have permission for this action." }, 403));
    if (action === "admin-view-tab") return audited(req, action, body, () => adminViewTab(body));
    if (action === "admin-change-passcode") return audited(req, action, body, () => changePasscode(body));
    if (action === "admin-save-event") return audited(req, action, body, () => saveEvent(body));
    if (action === "admin-generate-schedule") return audited(req, action, body, async () => reply(await generateEventSchedule(body.eventId)));
    if (action === "admin-save-match") return audited(req, action, body, () => adminSaveMatch(body));
    if (action === "admin-delete-event") return audited(req, action, body, () => deleteEvent(body));
    if (action === "admin-add-player") return audited(req, action, body, () => addPlayer(body));
    if (action === "admin-update-player") return audited(req, action, body, () => updatePlayer(body));
    if (action === "admin-remove-player") return audited(req, action, body, () => removePlayer(body));
    if (action === "admin-reset-player-pin") return audited(req, action, body, () => resetPlayerPin(body));
    if (action === "admin-set-eoi") return audited(req, action, body, () => adminSetEoi(body));
    if (action === "admin-add-guest") return audited(req, action, body, () => addGuest(body));
    if (action === "admin-remove-guest") return audited(req, action, body, () => removeGuest(body));
    if (action === "admin-set-payment") return audited(req, action, body, () => adminSetPayment(body));
    if (action === "admin-set-hours") return audited(req, action, body, () => adminSetPlayerHours(body));
    if (action === "admin-delete-score") return audited(req, action, body, () => adminDeleteScore(body));
    if (action === "admin-delete-media") return audited(req, action, body, () => adminDeleteMedia(body));
    if (action === "admin-create-tournament") return audited(req, action, body, () => createTournament(body));
    if (action === "admin-update-tournament-stages") return audited(req, action, body, () => updateTournamentStages(body));
    if (action === "admin-set-role") return audited(req, action, body, () => setAdminRole(body));
    if (action === "admin-create-role") return audited(req, action, body, () => createAdminRole(body));
    if (action === "admin-update-role") return audited(req, action, body, () => updateAdminRole(body));
    if (action === "admin-delete-role") return audited(req, action, body, () => deleteAdminRole(body));
    if (action === "admin-revert-audit") return audited(req, action, body, () => revertAudit(body));
    if (action === "admin-create-announcement") return audited(req, action, body, () => createAnnouncement(body));
    if (action === "admin-update-announcement") return audited(req, action, body, () => updateAnnouncement(body));
    if (action === "admin-delete-announcement") return audited(req, action, body, () => deleteAnnouncement(body));
    if (action === "admin-generate-tournament-draw") return audited(req, action, body, () => generateTournamentDraw(body));
    if (action === "admin-save-tournament-match") return audited(req, action, body, () => saveTournamentMatch(body));
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

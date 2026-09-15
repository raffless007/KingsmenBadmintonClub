import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "https://kingsmenclub.netlify.app";
const SYDNEY = "Australia/Sydney";

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
  if (!response.ok) throw new Error(`Database request failed (${response.status}) ${path}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
}

function localDateTimeToUtc(dateText, timeText) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute, second = 0] = timeText.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - timezoneOffsetMs(guess, SYDNEY));
}

function eventEndTime(event) {
  return [
    event.end_time,
    event.court_2_enabled ? event.court_2_end_time : null,
    event.court_3_enabled ? event.court_3_end_time : null,
  ].filter(Boolean).sort().at(-1);
}

async function deleteSubscription(endpoint) {
  await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

export default async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log("Push reminders skipped: VAPID or Supabase environment variables are missing.");
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const today = localDate();
  const [subscriptions, events, eois, payments, sent, preferences] = await Promise.all([
    db("push_subscriptions?select=player_id,endpoint,p256dh,auth"),
    db(`events?event_date=lte.${today}&select=id,event_date,end_time,court_2_enabled,court_2_end_time,court_3_enabled,court_3_end_time`),
    db("eois?select=event_id,player_id,status,penalty_amount&status=in.(yes,no)"),
    db("payments?select=event_id,player_id,paid"),
    db(`push_notification_log?reminder_date=eq.${today}&notification_type=eq.pending_payment&select=event_id,player_id`),
    db("player_notification_preferences?select=player_id,payment_reminders"),
  ]);
  const paymentReminders = new Map((preferences || []).map(row => [row.player_id, row.payment_reminders !== false]));
  const paid = new Set((payments || []).filter(row => row.paid).map(row => `${row.event_id}:${row.player_id}`));
  const alreadySent = new Set((sent || []).map(row => `${row.event_id}:${row.player_id}`));
  const subscriptionsByPlayer = new Map();
  for (const subscription of subscriptions || []) {
    const list = subscriptionsByPlayer.get(subscription.player_id) || [];
    list.push(subscription);
    subscriptionsByPlayer.set(subscription.player_id, list);
  }
  let sentCount = 0;
  for (const event of events || []) {
    if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event))) continue;
    const pending = (eois || []).filter(row => row.event_id === event.id
      && (row.status === "yes" || (row.status === "no" && Number(row.penalty_amount || 0) > 0))
      && !paid.has(`${event.id}:${row.player_id}`)
      && paymentReminders.get(row.player_id) !== false
      && !alreadySent.has(`${event.id}:${row.player_id}`));
    for (const row of pending) {
      const playerSubscriptions = subscriptionsByPlayer.get(row.player_id) || [];
      if (!playerSubscriptions.length) continue;
      const payload = JSON.stringify({
        title: "Kingsmen Badminton payment reminder",
        body: `Your payment for ${event.event_date} is still pending. Open the app to view the amount.`,
        url: "/?page=payments",
        tag: `payment-${event.id}`,
      });
      let delivered = false;
      for (const subscription of playerSubscriptions) {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload);
          delivered = true;
          sentCount += 1;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) await deleteSubscription(subscription.endpoint);
          else console.error("Push notification failed", error.message);
        }
      }
      if (delivered) {
        await db("push_notification_log", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({ player_id: row.player_id, event_id: event.id, notification_type: "pending_payment", reminder_date: today }),
        });
      }
    }
  }
  console.log(`Push reminders delivered: ${sentCount}`);
};

export const config = { schedule: "@daily" };

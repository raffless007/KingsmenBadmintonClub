(function () {
  "use strict";

  const API = "/.netlify/functions/api";
  const queueKey = "kbc-live-score-queue";
  const enhancement = { installed: false, originalRender: null, supabase: null, channel: null, pollTimer: null, flushing: false, adminRoles: [], lastAdminTab: null };
  const $ = (id) => document.getElementById(id);
  const evalGlobal = (name) => {
    try { return window[name] || window.eval(name); } catch { return undefined; }
  };
  const state = () => { try { return window.eval("data"); } catch { return {}; } };
  const playerId = () => { try { return window.eval("currentPlayerId"); } catch { return null; } };
  const adminToken = () => { try { return window.eval("adminToken"); } catch { return null; } };
  const notify = (message) => evalGlobal("notify")?.(message);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const prettyDate = (value) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`));
  const playerName = (id) => state().players?.find((player) => player.id === id)?.name || "Player";
  const request = () => evalGlobal("request");
  const refresh = () => evalGlobal("refresh")?.();

  function injectStyles() {
    if ($("kbcEnhancementStyles")) return;
    const style = document.createElement("style");
    style.id = "kbcEnhancementStyles";
    style.textContent = `
      .kbc-enhancement{margin-top:20px}.kbc-enhancement .card{padding:22px}.kbc-enhancement h3{margin:0}.kbc-muted{color:var(--muted);font-size:11px}.kbc-list{display:grid;gap:10px;margin-top:14px}.kbc-list-row{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--line);padding:11px 0}.kbc-list-row:first-child{border-top:0}.kbc-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#e7f7ff;color:var(--green);padding:5px 9px;font-size:9px;font-weight:900}.kbc-chip.warn{background:#fff3d6;color:#80601f}.kbc-chip.danger{background:#f8ebe4;color:var(--warn)}.kbc-calendar{margin-top:12px}.kbc-offline{display:inline-flex;align-items:center;gap:7px;background:#fff3d6;color:#80601f;border-radius:999px;padding:7px 10px;font-size:10px;font-weight:900}.kbc-offline.online{background:#e7f7ff;color:var(--green)}.kbc-fullscreen{border:1px solid var(--line);background:white;border-radius:10px;padding:8px 11px;font-size:10px;font-weight:900;cursor:pointer}.live-match:fullscreen{background:var(--paper);width:100vw;height:100vh;padding:7vh 12vw;display:grid;align-content:center}.live-match:fullscreen .live-points{font-size:clamp(72px,13vw,180px)}.live-match:fullscreen .live-team strong{font-size:clamp(22px,3vw,42px)}.live-match:fullscreen .pointbtn{font-size:clamp(16px,2vw,28px);padding:22px}.kbc-announcement{border-left:4px solid var(--green)}.kbc-announcement.alert{border-left-color:var(--warn)}.kbc-announcement p{white-space:pre-wrap;line-height:1.55}.kbc-stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}.kbc-stat{border:1px solid var(--line);border-radius:12px;padding:12px}.kbc-stat small,.kbc-stat strong{display:block}.kbc-stat small{color:var(--muted);font-size:8px;letter-spacing:1px}.kbc-stat strong{font-size:22px;margin-top:3px}.kbc-entry{border:1px solid var(--line);border-radius:12px;padding:12px}.kbc-match{border-top:1px solid var(--line);padding:12px 0;display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center}.kbc-match:first-child{border-top:0}.kbc-modal-grid{display:grid;gap:12px}.kbc-modal-grid label{display:flex;align-items:center;gap:10px;font-size:12px}.kbc-modal-grid input{width:18px;height:18px}.kbc-audit-json{max-width:280px;white-space:pre-wrap;word-break:break-word}.kbc-audit-human{border:1px solid var(--line);border-radius:12px;padding:14px;background:#fbfdfe}.kbc-audit-human + .kbc-audit-human{margin-top:10px}.kbc-audit-human p{margin:5px 0 0;font-size:12px;line-height:1.45}.kbc-audit-human .kbc-audit-meta{display:flex;justify-content:space-between;gap:12px;align-items:center}.kbc-audit-human .kbc-audit-change{font-size:14px;font-weight:850;margin-top:7px}.kbc-audit-human details{margin-top:9px}.kbc-audit-human summary{cursor:pointer;color:var(--green);font-size:10px;font-weight:900}.kbc-admin-tools{display:grid;gap:15px;margin-top:18px}.kbc-admin-tools textarea{min-height:100px}.kbc-admin-tools .actions{justify-content:flex-start}.kbc-role-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}.kbc-delete{color:var(--warn)}
      .kbc-role-permissions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:9px}.kbc-role-permission{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:9px;padding:8px;font-size:10px}.kbc-role-permission input{accent-color:var(--green)}.kbc-role-card{border-top:1px solid var(--line);padding:12px 0}.kbc-role-card:first-child{border-top:0}.kbc-role-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.kbc-admin-tools{padding:22px}.kbc-audit-log-card,.kbc-audit-snapshots-card{padding:22px}.kbc-audit-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.kbc-audit-human{min-width:0;margin:0}.kbc-audit-human + .kbc-audit-human{margin-top:0}.kbc-audit-human .kbc-audit-meta{align-items:flex-start;flex-direction:column;gap:7px}.kbc-audit-human .kbc-audit-person{font-size:13px;line-height:1.25}.kbc-audit-human .kbc-audit-context{color:var(--muted);font-size:10px;line-height:1.35}.kbc-audit-human .kbc-audit-change{font-size:12px;line-height:1.4}
      @media(max-width:1100px){.kbc-audit-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:800px){.kbc-stat-grid{grid-template-columns:repeat(2,1fr)}.kbc-match{grid-template-columns:1fr}.kbc-role-grid,.kbc-role-permissions{grid-template-columns:1fr}.kbc-admin-tools,.kbc-audit-log-card,.kbc-audit-snapshots-card{padding:16px}.kbc-audit-grid{grid-template-columns:1fr}.live-match:fullscreen{padding:5vh 5vw}}
    `;
    document.head.appendChild(style);
  }

  function calendarText(event) {
    const stamp = (time) => `${event.event_date.replaceAll("-", "")}T${String(time || "21:00:00").replaceAll(":", "")}`;
    const start = stamp(event.start_time);
    const end = stamp(event.end_time);
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kingsmen Badminton//EN", "BEGIN:VEVENT", `UID:kbc-${event.id}@kingsmenclub.netlify.app`, `DTSTART;TZID=Australia/Sydney:${start}`, `DTEND;TZID=Australia/Sydney:${end}`, `SUMMARY:Kingsmen Badminton`, `LOCATION:${event.location}, ${event.suburb || ""}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }

  function addCalendarButton(event) {
    const title = document.querySelector("#playPage .eventtitle");
    if (!title || title.querySelector(".kbc-calendar")) return;
    const button = document.createElement("button");
    button.className = "secondary kbc-calendar";
    button.textContent = "Add to calendar";
    button.onclick = () => {
      const blob = new Blob([calendarText(event)], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `kingsmen-${event.event_date}.ics`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    };
    title.appendChild(button);
  }

  function renderWaitlist(event) {
    const response = document.querySelector("#playPage .response");
    if (!response || response.querySelector(".kbc-waitlist")) return;
    const mine = state().waitlist?.find((row) => row.event_id === event.id && row.player_id === playerId() && row.status === "pending");
    const pending = (state().waitlist || []).filter((row) => row.event_id === event.id && row.status === "pending");
    if (!mine && !pending.length) return;
    const box = document.createElement("div");
    box.className = "kbc-waitlist note";
    box.style.marginTop = "12px";
    box.innerHTML = mine ? `<strong>You are on the waitlist at position ${mine.position}.</strong><br><span>You will be promoted automatically when a place opens.</span>` : `<strong>${pending.length} player${pending.length === 1 ? "" : "s"} on the waitlist.</strong>`;
    response.appendChild(box);
  }

  function renderAnnouncements() {
    const page = $("playPage");
    if (!page) return;
    let panel = $("kbcAnnouncements");
    if (!panel) { panel = document.createElement("div"); panel.id = "kbcAnnouncements"; panel.className = "kbc-enhancement"; page.appendChild(panel); }
    const items = state().announcements || [];
    panel.innerHTML = `<article class="card"><div class="cardhead"><div><p class="eyebrow">CLUB UPDATES</p><h3>Announcements</h3><p class="kbc-muted">Important club notes stay here for everyone.</p></div><span class="kbc-chip">${items.length} update${items.length === 1 ? "" : "s"}</span></div>${items.length ? `<div class="kbc-list">${items.slice(0, 6).map((item) => `<div class="kbc-announcement ${item.kind === "alert" ? "alert" : ""}"><div class="row"><strong>${esc(item.title)}</strong><small class="kbc-muted">${new Date(item.created_at).toLocaleDateString("en-AU")}</small></div><p class="kbc-muted">${esc(item.body)}</p>${playerId() ? `<button class="textbtn" data-kbc-read="${item.id}">Mark as read</button>` : ""}</div>`).join("")}</div>` : `<p class="kbc-muted" style="margin-top:14px">No club announcements yet.</p>`}</article>`;
    panel.querySelectorAll("[data-kbc-read]").forEach((button) => button.onclick = async () => { try { await request()("announcement-read", "POST", { playerId: playerId(), announcementId: button.dataset.kbcRead }); button.textContent = "Read"; button.disabled = true; } catch (error) { notify(error.message); } });
  }

  function renderNotificationPreferences() {
    const prompt = $("notificationPrompt");
    if (!prompt || prompt.querySelector("[data-kbc-preferences]")) return;
    const button = document.createElement("button");
    button.className = "textbtn";
    button.dataset.kbcPreferences = "true";
    button.textContent = "Notification preferences";
    button.onclick = openNotificationPreferences;
    prompt.appendChild(button);
  }

  function openNotificationPreferences() {
    const modal = $("modal"), content = $("modalContent");
    if (!modal || !content) return;
    const row = (key, label) => `<label><input type="checkbox" data-kbc-pref="${key}" checked> ${label}</label>`;
    content.innerHTML = `<p class="eyebrow">YOUR SETTINGS</p><h2>Notification preferences</h2><p class="kbc-muted">Choose which club updates can reach this device and account.</p><div class="kbc-modal-grid" style="margin-top:18px">${row("eoiReminders", "EOI deadlines and waitlist changes")}${row("scheduleChanges", "Pairing and schedule changes")}${row("paymentReminders", "Payment reminders")}${row("announcements", "Club announcements")}${row("tournamentUpdates", "Tournament updates")}</div><div class="actions" style="margin-top:18px"><button class="primary" id="kbcSavePrefs">Save preferences</button></div>`;
    const prefs = (state().notificationPreferences || []).find((item) => item.player_id === playerId()) || {};
    content.querySelectorAll("[data-kbc-pref]").forEach((input) => { const key = input.dataset.kbcPref.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`); input.checked = prefs[key] !== false; });
    $("kbcSavePrefs").onclick = async () => { const body = { playerId: playerId() }; content.querySelectorAll("[data-kbc-pref]").forEach((input) => { body[input.dataset.kbcPref] = input.checked; }); try { await request()("notification-preferences", "POST", body); notify("Notification preferences saved"); modal.classList.add("hidden"); refresh(); } catch (error) { notify(error.message); } };
    modal.classList.remove("hidden");
  }

  function addLiveUtilities() {
    document.querySelectorAll(".live-match").forEach((card) => {
      const id = card.dataset.scoreId || card.dataset.liveScore || card.querySelector("[data-live-point]")?.dataset.scoreId;
      if (!id || card.querySelector("[data-kbc-fullscreen]")) return;
      const button = document.createElement("button");
      button.className = "kbc-fullscreen";
      button.dataset.kbcFullscreen = id;
      button.textContent = "Full screen";
      button.onclick = () => card.requestFullscreen?.();
      card.querySelector(".live-match-top")?.appendChild(button);
    });
    const liveScores = $("liveScores");
    if (liveScores && !$("kbcOfflineStatus")) { const status = document.createElement("span"); status.id = "kbcOfflineStatus"; status.className = `kbc-offline ${navigator.onLine ? "online" : ""}`; status.textContent = navigator.onLine ? "Live sync ready" : "Offline queue active"; liveScores.querySelector(".score-section-head")?.appendChild(status); }
  }

  function readQueue() { try { return JSON.parse(localStorage.getItem(queueKey) || "[]"); } catch { return []; } }
  function writeQueue(queue) { localStorage.setItem(queueKey, JSON.stringify(queue)); const status = $("kbcOfflineStatus"); if (status) { const count = queue.length; status.textContent = navigator.onLine ? (count ? `${count} action${count === 1 ? "" : "s"} syncing` : "Live sync ready") : `Offline queue: ${count}`; status.classList.toggle("online", navigator.onLine && !count); } }
  async function flushQueue() {
    if (enhancement.flushing || !navigator.onLine) return;
    enhancement.flushing = true;
    try {
      const send = request();
      while (readQueue().length) {
        const queue = readQueue();
        try { await send("live-score", "POST", queue[0]); writeQueue(queue.slice(1)); }
        catch (error) { if (!navigator.onLine) break; notify(`Score sync paused: ${error.message}`); break; }
      }
    } finally { enhancement.flushing = false; }
  }

  function installOfflineScoring() {
    const current = evalGlobal("queueLiveAction");
    if (!current || current.__kbcEnhanced) return;
    const enhanced = (score, action, extra = {}) => {
      const body = { scoreId: score.id, playerId: playerId(), action, ...extra, clientActionId: crypto.randomUUID() };
      const queue = readQueue();
      queue.push(body);
      writeQueue(queue);
      flushQueue();
    };
    enhanced.__kbcEnhanced = true;
    window.__kbcQueueLiveAction = enhanced;
    try { window.eval("queueLiveAction = window.__kbcQueueLiveAction"); } catch { window.queueLiveAction = enhanced; }
    window.addEventListener("online", flushQueue);
    window.addEventListener("offline", () => writeQueue(readQueue()));
    writeQueue(readQueue());
  }

  async function syncScores(eventId) {
    const result = await fetch(`${API}?action=score-state&eventId=${encodeURIComponent(eventId)}`).then((response) => response.json());
    const current = state();
    if (!current || !Array.isArray(result.scores)) return;
    const otherScores = (current.scores || []).filter((score) => score.event_id !== eventId);
    current.scores = [...otherScores, ...result.scores];
    const renderScores = evalGlobal("renderScores");
    if (renderScores && !document.activeElement?.matches("input,select,textarea")) renderScores();
  }

  async function setupRealtime() {
    const scoresPage = $("scoresPage");
    if (!scoresPage?.classList.contains("active")) return;
    const eventId = (() => { try { return window.eval("scoreEventId"); } catch { return null; } })();
    if (!eventId) return;
    if (!enhancement.supabase) {
      try {
        const config = await fetch(`${API}?action=push-config`).then((response) => response.json());
        if (window.supabase?.createClient && config.supabaseUrl && config.supabaseAnonKey) {
          enhancement.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
          enhancement.channel = enhancement.supabase.channel("kbc-live-score-changes").on("postgres_changes", { event: "*", schema: "public", table: "match_scores" }, (payload) => { const changedEvent = payload.new?.event_id || payload.old?.event_id; if (changedEvent) syncScores(changedEvent).catch(() => {}); }).subscribe();
        }
      } catch { /* polling remains the fallback */ }
    }
    if (!enhancement.pollTimer) enhancement.pollTimer = setInterval(() => { if ($("scoresPage")?.classList.contains("active")) syncScores(eventId).catch(() => {}); }, 1200);
  }

  function renderStats() {
    const panel = $("playerStats");
    const current = state();
    if (!panel || !current.players?.length) return;
    const completed = (current.scores || []).filter((score) => score.status === "completed" || (!score.status && score.completed_at));
    const played = new Map(current.players.map((player) => [player.id, { played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 }]));
    completed.forEach((score) => { const a = Number(score.points_a || score.games_a || 0); const b = Number(score.points_b || score.games_b || 0); const winner = a > b ? "A" : "B"; [...(score.team_a_player_ids || [])].forEach((id) => { const row = played.get(id); if (row) { row.played += 1; row.wins += winner === "A" ? 1 : 0; row.losses += winner === "B" ? 1 : 0; row.pointsFor += a; row.pointsAgainst += b; } }); [...(score.team_b_player_ids || [])].forEach((id) => { const row = played.get(id); if (row) { row.played += 1; row.wins += winner === "B" ? 1 : 0; row.losses += winner === "A" ? 1 : 0; row.pointsFor += b; row.pointsAgainst += a; } }); });
    const top = [...played.entries()].map(([id, row]) => ({ id, ...row })).sort((a, b) => b.wins - a.wins || b.played - a.played).slice(0, 8);
    let insights = panel.querySelector(".kbc-stats-insights");
    if (!insights) { insights = document.createElement("div"); insights.className = "kbc-stats-insights"; panel.prepend(insights); }
    insights.innerHTML = `<p class="eyebrow">PLAYER INSIGHTS</p><div class="kbc-stat-grid"><div class="kbc-stat"><small>COMPLETED MATCHES</small><strong>${completed.length}</strong></div><div class="kbc-stat"><small>ACTIVE PLAYERS</small><strong>${current.players.filter((player) => player.active).length}</strong></div><div class="kbc-stat"><small>LIVE BOARDS</small><strong>${(current.scores || []).filter((score) => score.status === "live").length}</strong></div><div class="kbc-stat"><small>YOUR MATCHES</small><strong>${played.get(playerId())?.played || 0}</strong></div></div><div class="kbc-list">${top.map((row) => `<div class="kbc-list-row"><strong>${esc(playerName(row.id))}</strong><span class="kbc-muted">${row.wins}W · ${row.losses}L · ${row.played} played · ${row.pointsFor - row.pointsAgainst >= 0 ? "+" : ""}${row.pointsFor - row.pointsAgainst} diff</span></div>`).join("")}</div>`;
  }

  function renderTournamentWorkflow() {
    const host = $("tournamentPanel");
    const current = state();
    if (!host || !current.tournaments) return;
    let panel = $("kbcTournamentWorkflow");
    if (!panel) { panel = document.createElement("div"); panel.id = "kbcTournamentWorkflow"; panel.className = "kbc-enhancement"; host.appendChild(panel); }
    panel.innerHTML = `<article class="card"><div class="cardhead"><div><p class="eyebrow">REGISTRATION AND DRAW</p><h3>Tournament workspace</h3><p class="kbc-muted">Register players, generate the draw, and record tournament results from one place.</p></div></div>${current.tournaments.map((tournament) => { const entries = (current.tournamentEntries || []).filter((entry) => entry.tournament_id === tournament.id); const matches = (current.tournamentMatches || []).filter((match) => match.tournament_id === tournament.id); const mine = entries.find((entry) => entry.player_id === playerId()); return `<div class="kbc-entry" style="margin-top:14px"><div class="cardhead"><div><strong>${esc(tournament.name)}</strong><p class="kbc-muted">${prettyDate(tournament.tournament_date)} · ${entries.filter((entry) => entry.status === "registered").length} registered</p></div><span class="kbc-chip">${esc(tournament.status)}</span></div><div class="actions" style="justify-content:flex-start;margin-top:12px">${playerId() && !mine && ["draft", "registration_open"].includes(tournament.status) ? `<button class="secondary" data-kbc-register="${tournament.id}">Register</button>` : mine ? `<span class="kbc-chip ${mine.status === "waitlisted" ? "warn" : ""}">${mine.status}</span>` : ""}${adminToken() ? `<button class="primary" data-kbc-draw="${tournament.id}">${matches.length ? "Regenerate draw" : "Generate draw"}</button>` : ""}</div>${entries.length ? `<div class="kbc-list">${entries.map((entry) => `<div class="kbc-list-row"><span>${esc(playerName(entry.player_id))}${entry.partner_player_id ? ` & ${esc(playerName(entry.partner_player_id))}` : ""}</span><span class="kbc-chip ${entry.status === "waitlisted" ? "warn" : ""}">${entry.status}</span></div>`).join("")}</div>` : ""}${matches.length ? `<div class="kbc-list"><p class="eyebrow" style="margin-top:16px">MATCHES</p>${matches.map((match) => { const a = (match.team_a_entry_ids || []).map((id) => entries.find((entry) => entry.id === id)).filter(Boolean).map((entry) => playerName(entry.player_id)).join(" & "); const b = (match.team_b_entry_ids || []).map((id) => entries.find((entry) => entry.id === id)).filter(Boolean).map((entry) => playerName(entry.player_id)).join(" & "); return `<div class="kbc-match"><small>Match ${match.match_number}<br>${match.scheduled_start || ""} · ${esc(match.court_name || "Court")}</small><strong>${esc(a)} vs ${esc(b)}</strong>${adminToken() && match.status !== "completed" ? `<button class="secondary" data-kbc-tournament-result="${match.id}">Result</button>` : `<span class="kbc-chip">${match.status}</span>`}</div>`; }).join("")}</div>` : ""}</div>`; }).join("")}</article>`;
    panel.querySelectorAll("[data-kbc-register]").forEach((button) => button.onclick = async () => { try { const result = await request()("tournament-register", "POST", { tournamentId: button.dataset.kbcRegister, playerId: playerId() }); notify(result.waitlisted ? "Tournament is full; you are waitlisted." : "Tournament registration saved"); refresh(); } catch (error) { notify(error.message); } });
    panel.querySelectorAll("[data-kbc-draw]").forEach((button) => button.onclick = async () => { try { await request()("admin-generate-tournament-draw", "POST", { tournamentId: button.dataset.kbcDraw }, true); notify("Tournament draw generated"); refresh(); } catch (error) { notify(error.message); } });
    panel.querySelectorAll("[data-kbc-tournament-result]").forEach((button) => button.onclick = async () => { const a = prompt("Winning games for Team A", "1"); const b = prompt("Winning games for Team B", "0"); if (a === null || b === null) return; try { await request()("admin-save-tournament-match", "POST", { matchId: button.dataset.kbcTournamentResult, gamesA: Number(a), gamesB: Number(b) }, true); notify("Tournament result saved"); refresh(); } catch (error) { notify(error.message); } });
  }

  function renderAdminEnhancements() {
    if (!adminToken()) return;
    const panel = $("settingsPanel");
    if (!panel || panel.querySelector("#kbcAdminTools")) return;
    const tools = document.createElement("article");
    tools.id = "kbcAdminTools";
    tools.className = "card kbc-admin-tools";
    tools.innerHTML = `<div><p class="eyebrow">ADMIN SETTINGS</p><h3>Club updates and admin access</h3><p class="kbc-muted">Publish announcements, create custom roles, choose their app permissions, and assign them to players. The shared admin passcode remains the owner session.</p></div><form id="kbcAnnouncementForm"><div class="formgrid"><label><span class="label">TITLE</span><input class="control" name="title" required maxlength="160" placeholder="Thursday court update"></label><label><span class="label">TYPE</span><select class="control" name="kind"><option value="announcement">Announcement</option><option value="message">Message</option><option value="alert">Alert</option></select></label><label class="full"><span class="label">MESSAGE</span><textarea class="control" name="body" required maxlength="5000" placeholder="Write the note players should see."></textarea></label><label><span class="label">PIN TO TOP</span><input type="checkbox" name="pinned"></label></div><div class="actions"><button class="primary">Publish update</button></div></form><div><p class="eyebrow">ADMIN ROLES</p><div id="kbcRoles"></div></div>`;
    panel.appendChild(tools);
    $("kbcAnnouncementForm").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await request()("admin-create-announcement", "POST", { title: form.get("title"), body: form.get("body"), kind: form.get("kind"), pinned: form.get("pinned") === "on" }, true); notify("Announcement published"); event.currentTarget.reset(); refresh(); } catch (error) { notify(error.message); } };
    renderAdminRoles();
  }

  function renderAdminRoleLogin() {
    const lock = $("adminLock");
    if (!lock || adminToken() || lock.querySelector("#kbcRoleLogin")) return;
    const box = document.createElement("div");
    box.id = "kbcRoleLogin";
    box.className = "kbc-enhancement";
    box.innerHTML = `<article class="card" style="margin-top:16px;padding:18px;text-align:left"><p class="eyebrow">ROLE LOGIN</p><h3>Admin team access</h3><p class="kbc-muted">Owners can assign a role from Settings. Role holders sign in with their player PIN.</p><div class="formgrid" style="margin-top:10px"><label><span class="label">PLAYER</span><select class="control" id="kbcAdminPlayer"><option value="">Choose player</option>${(state().players || []).filter((player) => player.active).map((player) => `<option value="${player.id}">${esc(player.name)}</option>`).join("")}</select></label><label><span class="label">PLAYER PIN</span><input class="control" id="kbcAdminPlayerPin" inputmode="numeric" type="password" maxlength="6" placeholder="4 or 6 digits"></label></div><button class="secondary" id="kbcRoleLoginButton" style="margin-top:12px">Sign in with role</button></article>`;
    lock.appendChild(box);
    $("kbcRoleLoginButton").onclick = async () => { const body = { playerId: $("kbcAdminPlayer").value, playerPin: $("kbcAdminPlayerPin").value }; if (!body.playerId || !body.playerPin) return notify("Choose your player and enter your PIN"); try { const response = await fetch(`${API}?action=admin-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (result) => { const json = await result.json(); if (!result.ok) throw new Error(json.error || "Admin login failed"); return json; }); sessionStorage.setItem("kbc-admin-token", response.token); location.reload(); } catch (error) { notify(error.message); } };
  }

  async function renderAdminRoles() {
    const target = $("kbcRoles");
    if (!target || !adminToken()) return;
    try {
      const result = await request()("admin-state", "GET", null, true);
      enhancement.adminRoles = result.roles || [];
      const players = result.players || [];
      const definitions = (result.roleDefinitions || []).filter((role) => role.active);
      const canManage = Boolean(result.canManageRoles);
      const permissions = [
        ["events", "Weekly events"], ["schedule", "Schedules and matchups"], ["eoi", "Attendance and EOI"],
        ["money", "Payments and shuttle fees"], ["scores", "Scores and live scoring"], ["roster", "Player roster and PINs"],
        ["media", "Media"], ["tournaments", "Tournaments"], ["announcements", "Announcements"], ["roles", "Admin roles"], ["audit", "Audit log"],
      ];
      document.querySelectorAll("[data-tab]").forEach((button) => {
        const permission = { events: "events", schedule: "schedule", eois: "eoi", roster: "roster", money: "money", adminScores: "scores", auditLog: "audit", settings: "roles" }[button.dataset.tab];
        const allowed = button.dataset.tab === "settings" ? (canManage || result.permissions?.includes("announcements")) : !permission || result.permissions?.includes(permission);
        button.style.display = allowed ? "" : "none";
        const panel = $(`${button.dataset.tab}Panel`);
        if (panel && !allowed) panel.classList.remove("active");
      });
      if (!document.querySelector("[data-tab].active:not([style*='display: none'])")) document.querySelector("[data-tab]:not([style*='display: none'])")?.click();
      const roleOptions = definitions.map((role) => `<option value="${esc(role.slug)}">${esc(role.name)}</option>`).join("");
      const assigned = enhancement.adminRoles.filter((role) => role.active);
      const permissionLabels = new Map(permissions);
      const permissionChecks = (selected = []) => `<div class="kbc-role-permissions">${permissions.map(([key, label]) => `<label class="kbc-role-permission"><input type="checkbox" data-kbc-permission="${key}" ${selected.includes(key) ? "checked" : ""}> ${esc(label)}</label>`).join("")}</div>`;
      const roleCards = definitions.map((role) => `<div class="kbc-role-card"><div class="row"><div><strong>${esc(role.name)}</strong><p class="kbc-muted">${esc(role.description || "No description")}</p></div>${role.is_system ? `<span class="kbc-chip">Default</span>` : canManage ? `<div class="actions"><button class="secondary" data-kbc-edit-role="${esc(role.slug)}">Edit</button><button class="secondary kbc-delete" data-kbc-delete-role="${esc(role.slug)}">Archive</button></div>` : ""}</div><div class="kbc-role-chips">${(Array.isArray(role.permissions) ? role.permissions : []).map((permission) => `<span class="kbc-chip">${esc(permissionLabels.get(permission) || permission)}</span>`).join("")}</div></div>`).join("");
      target.innerHTML = `${canManage ? `<form id="kbcRoleForm"><div class="formgrid"><label><span class="label">ROLE NAME</span><input class="control" id="kbcRoleName" required maxlength="60" placeholder="Tournament coordinator"></label><label><span class="label">DESCRIPTION</span><input class="control" id="kbcRoleDescription" maxlength="240" placeholder="What this role is responsible for"></label></div><p class="label" style="margin-top:12px">ACCESS TO APP FUNCTIONS</p>${permissionChecks()}<div class="actions"><button class="secondary" type="button" id="kbcCancelRoleEdit" style="display:none">Cancel edit</button><button class="primary" type="submit" id="kbcSaveRole">Create role</button></div></form>` : `<p class="kbc-muted">Your current admin role can use the functions shown below, but only the owner can create, edit, archive, or assign roles.</p>`}<div style="margin-top:18px"><p class="eyebrow">ROLE CATALOGUE</p>${roleCards || `<p class="kbc-muted">No active roles have been configured.</p>`}</div>${canManage ? `<div style="margin-top:20px"><p class="eyebrow">ASSIGN A ROLE</p><div class="kbc-role-grid"><select class="control" id="kbcRolePlayer"><option value="">Choose player</option>${players.filter((player) => player.active).map((player) => `<option value="${player.id}">${esc(player.name)}</option>`).join("")}</select><select class="control" id="kbcRoleValue"><option value="">Choose role</option>${roleOptions}</select><button class="secondary" id="kbcAssignRole">Assign</button></div><div class="kbc-list">${assigned.length ? assigned.map((role) => `<div class="kbc-list-row"><span><strong>${esc(players.find((player) => player.id === role.player_id)?.name || role.player_id)}</strong><small class="kbc-muted">${esc(definitions.find((definition) => definition.slug === role.role)?.name || role.role)}</small></span><button class="secondary kbc-delete" data-kbc-revoke-role="${role.player_id}">Revoke</button></div>`).join("") : `<p class="kbc-muted">No player roles are assigned.</p>`}</div></div>` : ""}`;
      if (!canManage) return;
      let editingSlug = null;
      const setForm = (role) => { editingSlug = role?.slug || null; $("kbcRoleName").value = role?.name || ""; $("kbcRoleDescription").value = role?.description || ""; target.querySelectorAll("[data-kbc-permission]").forEach((input) => { input.checked = (role?.permissions || []).includes(input.dataset.kbcPermission); }); $("kbcSaveRole").textContent = role ? "Save role" : "Create role"; $("kbcCancelRoleEdit").style.display = role ? "" : "none"; if (role) $("kbcRoleName").focus(); };
      $("kbcRoleForm").onsubmit = async (event) => { event.preventDefault(); const body = { name: $("kbcRoleName").value.trim(), description: $("kbcRoleDescription").value.trim(), permissions: [...target.querySelectorAll("[data-kbc-permission]:checked")].map((input) => input.dataset.kbcPermission) }; try { await request()(editingSlug ? "admin-update-role" : "admin-create-role", "POST", editingSlug ? { ...body, slug: editingSlug } : body, true); notify(editingSlug ? "Admin role updated" : "Admin role created"); await refresh(); renderAdminRoles(); } catch (error) { notify(error.message); } };
      $("kbcCancelRoleEdit").onclick = () => setForm(null);
      target.querySelectorAll("[data-kbc-edit-role]").forEach((button) => button.onclick = () => setForm(definitions.find((role) => role.slug === button.dataset.kbcEditRole)));
      target.querySelectorAll("[data-kbc-delete-role]").forEach((button) => button.onclick = async () => { if (!confirm("Archive this role and revoke it from assigned users?")) return; try { await request()("admin-delete-role", "POST", { slug: button.dataset.kbcDeleteRole }, true); notify("Admin role archived"); await refresh(); renderAdminRoles(); } catch (error) { notify(error.message); } });
      $("kbcAssignRole").onclick = async () => { if (!$("kbcRolePlayer").value || !$("kbcRoleValue").value) return notify("Choose a player and role"); try { await request()("admin-set-role", "POST", { playerId: $("kbcRolePlayer").value, role: $("kbcRoleValue").value, active: true }, true); notify("Admin role assigned"); await refresh(); renderAdminRoles(); } catch (error) { notify(error.message); } };
      target.querySelectorAll("[data-kbc-revoke-role]").forEach((button) => button.onclick = async () => { try { const current = assigned.find((role) => role.player_id === button.dataset.kbcRevokeRole); await request()("admin-set-role", "POST", { playerId: button.dataset.kbcRevokeRole, role: current.role, active: false }, true); notify("Admin role revoked"); await refresh(); renderAdminRoles(); } catch (error) { notify(error.message); } });
    } catch (error) { target.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  }

  function auditEvent(log) {
    const details = log.details || {};
    const eventId = details.eventId || (log.target_type === "event" ? log.target_id : null);
    return (state().events || []).find((event) => event.id === eventId);
  }

  function auditPlayer(id) {
    return id ? playerName(id) : "a player";
  }

  function auditTarget(log) {
    const details = log.details || {};
    const event = auditEvent(log);
    if (event) return `${prettyDate(event.event_date)} session${event.location ? ` at ${event.location}` : ""}`;
    if (details.playerId && log.target_type !== "event") return auditPlayer(details.playerId);
    if (log.target_type === "tournament") return state().tournaments?.find((item) => item.id === log.target_id)?.name || "a tournament";
    if (log.target_type === "match_score") return "a scheduled match";
    if (log.target_type === "media") return "a media item";
    if (log.target_type === "announcement") return "a club announcement";
    return log.target_type ? `the ${String(log.target_type).replaceAll("_", " ")}` : "the clubhouse";
  }

  function auditRoleLabel(log) {
    const role = log.details?.adminRole;
    if (!role) return "Owner session";
    return ({ owner: "Owner", admin: "Administrator", treasurer: "Treasurer", scheduler: "Session Coordinator", scorekeeper: "Scorekeeper", media: "Media Manager" }[role] || role);
  }

  function auditActor(log) {
    if (log.actor_type === "admin") return log.actor_name || (log.actor_id ? playerName(log.actor_id) : "Owner (shared passcode)");
    if (log.actor_type === "player") return log.actor_name || playerName(log.actor_id);
    return "A visitor";
  }

  function auditArea(action, log = {}) {
    if (action === "admin-view-tab") return `Admin > ${log.details?.tabLabel || log.details?.adminTab || "dashboard"}`;
    const areas = {
      "admin-save-event": "Weekly events",
      "admin-delete-event": "Weekly events",
      "admin-generate-schedule": "Schedules and matchups",
      "admin-save-match": "Schedules and matchups",
      "admin-set-eoi": "Attendance and EOI",
      "admin-set-payment": "Payments and shuttle fees",
      "admin-set-hours": "Payments and shuttle fees",
      "admin-delete-score": "Scores and live scoring",
      "admin-create-tournament": "Tournaments",
      "admin-generate-tournament-draw": "Tournaments",
      "admin-save-tournament-match": "Scores and live scoring",
      "admin-create-announcement": "Announcements",
      "admin-update-announcement": "Announcements",
      "admin-delete-announcement": "Announcements",
      "admin-set-role": "Admin roles",
      "admin-create-role": "Admin roles",
      "admin-update-role": "Admin roles",
      "admin-delete-role": "Admin roles",
      "admin-reset-player-pin": "Player roster and PINs",
      "admin-add-player": "Player roster and PINs",
      "admin-update-player": "Player roster and PINs",
      "admin-remove-player": "Player roster and PINs",
      "admin-change-passcode": "Admin security",
      "admin-revert-audit": "Audit log",
      "admin-delete-media": "Media",
      "admin-state": "Admin settings",
      "admin-audit-log": "Audit log",
    };
    if (areas[action]) return areas[action];
    if (["eoi", "paid", "shuttle-fee", "save-pairing", "announcement-read"].includes(action)) return "the weekly session area";
    if (["score", "live-score", "live-score-new"].includes(action)) return "the Scores area";
    if (["media-upload-url", "media-finalize", "admin-delete-media"].includes(action)) return "the Media area";
    if (action.includes("tournament")) return "the Tournaments area";
    if (["push-subscribe", "push-unsubscribe", "notification-preferences"].includes(action)) return "notification settings";
    if (action.startsWith("admin-")) return "Admin settings";
    if (["player-pin", "add-player"].includes(action)) return "player sign-in or profile settings";
    return "the clubhouse";
  }

  function auditStatus(value) {
    if (value === "yes") return "In";
    if (value === "no") return "Out";
    if (value === "none") return "No response";
    return value || "updated";
  }

  function auditMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "the updated amount";
  }

  function auditFieldLabel(field) {
    return String(field).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function auditValue(field, value) {
    if (value === undefined || value === null || value === "") return "not set";
    if (typeof value === "boolean") return value ? "on" : "off";
    if (Array.isArray(value)) return value.map((item) => state().players?.some((player) => player.id === item) ? playerName(item) : String(item)).join(" + ") || "none";
    if (typeof value === "object") return JSON.stringify(value);
    if (field.endsWith("_fee") || field === "shuttle_fee" || field === "amount") return auditMoney(value);
    return String(value);
  }

  function auditDiff(log) {
    const before = log.before_data || {};
    const after = log.after_data || {};
    const fields = Array.isArray(log.details?.changedFields) && log.details.changedFields.length
      ? log.details.changedFields
      : Object.keys({ ...before, ...after }).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
    return fields
      .filter((field) => !["id", "created_at", "updated_at", "completed_at", "paid_at", "locked_at"].includes(field))
      .slice(0, 6)
      .map((field) => `${auditFieldLabel(field)}: ${auditValue(field, before[field])} -> ${auditValue(field, after[field])}`)
      .join("; ");
  }

  function auditChange(log) {
    const action = log.action || "";
    const details = log.details || {};
    const target = auditTarget(log);
    const fields = Array.isArray(details.changedFields) && details.changedFields.length
      ? ` (${details.changedFields.map((field) => String(field).replaceAll("_", " ")).join(", ")})`
      : "";
    if (action === "admin-view-tab") return `Viewed the Admin > ${details.tabLabel || details.adminTab || "dashboard"} tab. No data was changed.`;
    if (action === "admin-audit-log") return "Viewed the Admin > Audit log tab. No data was changed.";
    if (action === "admin-state") return details.tabLabel ? `Loaded Admin > ${details.tabLabel} data in the background. No data was changed.` : "Loaded Admin dashboard data in the background. No data was changed.";
    if (action === "eoi" || action === "admin-set-eoi") return `Changed ${auditPlayer(details.playerId)}'s attendance response for the ${target} to ${auditStatus(details.status)}.`;
    if (action === "paid" || action === "admin-set-payment") return `Changed ${auditPlayer(details.playerId)}'s payment status for the ${target} to ${details.paid ? "Paid" : "Outstanding"}.`;
    if (action === "shuttle-fee") return `Updated the shuttle fee for the ${target} to ${auditMoney(details.shuttleFee)}.`;
    if (action === "admin-set-hours") return `Changed ${auditPlayer(details.playerId)}'s playing time for the ${target} to ${details.hoursPlayed || "0"} hours.`;
    if (action === "score") return `Entered or updated a match result for the ${target}${details.targetPoints ? ` using ${details.targetPoints} points` : ""}.`;
    if (action === "live-score-new") return `Started a new live doubles match for the ${target}.`;
    if (action === "live-score") {
      const liveAction = details.action === "pointA" ? "added a point to Team A" : details.action === "pointB" ? "added a point to Team B" : details.action === "undo" ? "undid the last point" : details.action === "start" ? "started the match" : details.action === "configure" ? "changed the match settings" : "updated the live score";
      return `${liveAction.charAt(0).toUpperCase()}${liveAction.slice(1)} for ${target}.`;
    }
    if (action === "save-pairing") return `Saved the complete player pairing set for the ${target}; the schedule was refreshed.`;
    if (action === "admin-save-event") return `Updated the event details for the ${target}${auditDiff(log) ? ` Changes: ${auditDiff(log)}.` : fields + "."}`;
    if (action === "admin-delete-event") return `Deleted the upcoming event for the ${target}.`;
    if (action === "admin-generate-schedule") return `Generated a new rotation schedule for the ${target}.`;
    if (action === "admin-save-match") return `Updated a scheduled matchup for the ${target}${auditDiff(log) ? ` Changes: ${auditDiff(log)}.` : fields + "."}`;
    if (action === "admin-delete-score") return `Deleted a recorded match result for the ${target}.`;
    if (action === "admin-create-tournament") return `Created the tournament${details.name ? ` "${details.name}"` : ""}.`;
    if (action === "admin-generate-tournament-draw") return `Generated the tournament draw for ${target}.`;
    if (action === "admin-save-tournament-match") return `Updated a tournament match result for ${target}.`;
    if (action === "admin-create-announcement") return `Published a club announcement${details.title ? ` titled "${details.title}"` : ""}.`;
    if (action === "admin-update-announcement") return `Updated ${target}.`;
    if (action === "admin-delete-announcement") return `Archived ${target}.`;
    if (action === "admin-set-role") return `Assigned the ${details.role || "selected"} admin role to ${auditPlayer(details.playerId)}.`;
    if (action === "admin-create-role") return `Created the custom admin role${details.name ? ` "${details.name}"` : ""} with ${Array.isArray(details.permissions) ? details.permissions.length : "selected"} permission${details.permissions?.length === 1 ? "" : "s"}.`;
    if (action === "admin-update-role") return `Updated the custom admin role${details.name ? ` "${details.name}"` : ""} and its permissions.`;
    if (action === "admin-delete-role") return `Archived the custom admin role${details.slug ? ` "${details.slug}"` : ""} and revoked its active assignments.`;
    if (action === "admin-reset-player-pin") return `Reset the PIN for ${auditPlayer(details.playerId)}.`;
    if (action === "admin-change-passcode") return "Changed the clubhouse admin passcode. The new passcode was not recorded.";
    if (action === "admin-revert-audit") return "Restored the earlier value from an audit entry.";
    if (action === "player-pin") return "Signed in or created a player PIN. PIN digits were not recorded.";
    if (action === "push-subscribe") return "Enabled push notifications for this device.";
    if (action === "push-unsubscribe") return "Disabled push notifications for this device.";
    if (action === "notification-preferences") return "Updated notification preferences.";
    if (action === "announcement-read") return `Marked ${target} as read.`;
    if (action === "tournament-register") return `Registered for ${target}.`;
    if (action === "admin-login") return "Signed in to the admin area.";
    if (action === "add-player") return `Added ${details.name ? `the player ${details.name}` : "a new player"}.`;
    return `Performed "${action.replaceAll("-", " ")}" on ${target}.`;
  }

  function renderPlainAuditLog(panel, logs) {
    let section = panel.querySelector("#kbcAuditPlainEnglish");
    if (!section) { section = document.createElement("article"); section.id = "kbcAuditPlainEnglish"; section.className = "card kbc-enhancement kbc-audit-log-card"; panel.prepend(section); }
    section.innerHTML = `<h3>Activity Audit Log</h3><div class="kbc-audit-grid">${logs.slice(0, 50).map((log) => `<div class="kbc-audit-human"><div class="kbc-audit-meta"><strong class="kbc-audit-person">${esc(auditActor(log))}</strong><span class="kbc-chip">${esc(auditRoleLabel(log))}</span><span class="kbc-chip ${log.succeeded ? "" : "danger"}">${log.succeeded ? "Completed" : "Failed"}</span></div><p class="kbc-audit-context"><strong>${esc(auditArea(log.action, log))}</strong><br>${esc(new Date(log.created_at).toLocaleString("en-AU"))}</p><p class="kbc-audit-change">${esc(auditChange(log))}</p><p><strong>Result:</strong> ${log.succeeded ? "Completed successfully." : `Failed${log.status_code ? ` (${log.status_code})` : ""}.`}</p><details><summary>Technical record</summary><div class="kbc-audit-json"><strong>Action</strong> ${esc(log.action)}<br><strong>Target</strong> ${esc(log.target_type || "-")} ${esc(log.target_id || "")}<br><strong>Details</strong> ${esc(JSON.stringify(log.details || {}, null, 2))}</div></details></div>`).join("")}</div>`;
  }

  function renderAuditEnhancements() {
    const panel = $("auditLogPanel");
    const logs = (() => { try { return window.eval("adminAuditLogs") || []; } catch { return []; } })();
    if (!panel || !logs.length) return;
    renderPlainAuditLog(panel, logs);
    if (panel.querySelector("#kbcAuditSnapshots")) return;
    const reversible = logs.filter((log) => log.before_data && !log.reverted_at).slice(0, 20);
    const section = document.createElement("article");
    section.id = "kbcAuditSnapshots";
    section.className = "card kbc-enhancement kbc-audit-snapshots-card";
    section.innerHTML = `<p class="eyebrow">BEFORE AND AFTER</p><h3>Reversible change history</h3><p class="kbc-muted">Use Revert only when the earlier value should be restored.</p><div class="kbc-list">${reversible.length ? reversible.map((log) => `<div class="kbc-list-row"><div><strong>${esc(log.action)}</strong><p class="kbc-muted">${esc(log.target_type)} · ${new Date(log.created_at).toLocaleString("en-AU")}</p><details><summary>View snapshot</summary><div class="kbc-audit-json"><strong>Before</strong> ${esc(JSON.stringify(log.before_data, null, 2))}<br><strong>After</strong> ${esc(JSON.stringify(log.after_data, null, 2))}</div></details></div><button class="secondary kbc-delete" data-kbc-revert="${log.id}">Revert</button></div>`).join("") : `<p class="kbc-muted">No reversible changes are available.</p>`}</div>`;
    panel.appendChild(section);
    section.querySelectorAll("[data-kbc-revert]").forEach((button) => button.onclick = async () => { if (!confirm("Restore the before snapshot for this action?")) return; try { await request()("admin-revert-audit", "POST", { auditId: button.dataset.kbcRevert }, true); notify("Change reverted"); refresh(); } catch (error) { notify(error.message); } });
  }

  async function logAdminTabView(tab) {
    if (!tab || !adminToken()) return;
    try { await request()("admin-view-tab", "POST", { adminTab: tab }, true); } catch { /* Audit telemetry must never interrupt navigation. */ }
  }

  function enhanceRender() {
    injectStyles();
    const activeAdminTab = document.querySelector("#adminPage .tabs [data-tab].active");
    if (adminToken() && activeAdminTab && enhancement.lastAdminTab !== activeAdminTab.dataset.tab) {
      enhancement.lastAdminTab = activeAdminTab.dataset.tab;
      logAdminTabView(enhancement.lastAdminTab);
    } else if (!adminToken()) enhancement.lastAdminTab = null;
    const current = state();
    const events = current.events || [];
    const selected = (() => { try { return window.eval("upcoming()[selected]"); } catch { return events[0]; } })();
    if (selected) { addCalendarButton(selected); renderWaitlist(selected); }
    renderAnnouncements();
    renderNotificationPreferences();
    addLiveUtilities();
    installOfflineScoring();
    renderStats();
    renderTournamentWorkflow();
    renderAdminEnhancements();
    renderAdminRoleLogin();
    renderAuditEnhancements();
    setupRealtime();
    flushQueue();
  }

  function install() {
    if (enhancement.installed) return;
    enhancement.installed = true;
    window.addEventListener("kbc-audit-updated", () => setTimeout(renderAuditEnhancements, 0));
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-page], [data-tab]")) setTimeout(enhanceRender, 0);
    });
    enhancement.originalRender = evalGlobal("render");
    if (enhancement.originalRender) {
      const wrapped = function () { enhancement.originalRender.apply(this, arguments); setTimeout(enhanceRender, 0); };
      window.__kbcWrappedRender = wrapped;
      try { window.eval("render = window.__kbcWrappedRender"); } catch { window.render = wrapped; }
    }
    setTimeout(enhanceRender, 50);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();

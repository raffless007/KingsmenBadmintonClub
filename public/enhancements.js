(function () {
  "use strict";

  const API = "/.netlify/functions/api";
  const queueKey = "kbc-live-score-queue";
  const enhancement = { installed: false, originalRender: null, supabase: null, channel: null, pollTimer: null, flushing: false, adminRoles: [] };
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
      .kbc-enhancement{margin-top:20px}.kbc-enhancement .card{padding:22px}.kbc-enhancement h3{margin:0}.kbc-muted{color:var(--muted);font-size:11px}.kbc-list{display:grid;gap:10px;margin-top:14px}.kbc-list-row{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--line);padding:11px 0}.kbc-list-row:first-child{border-top:0}.kbc-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#e7f7ff;color:var(--green);padding:5px 9px;font-size:9px;font-weight:900}.kbc-chip.warn{background:#fff3d6;color:#80601f}.kbc-chip.danger{background:#f8ebe4;color:var(--warn)}.kbc-calendar{margin-top:12px}.kbc-offline{display:inline-flex;align-items:center;gap:7px;background:#fff3d6;color:#80601f;border-radius:999px;padding:7px 10px;font-size:10px;font-weight:900}.kbc-offline.online{background:#e7f7ff;color:var(--green)}.kbc-fullscreen{border:1px solid var(--line);background:white;border-radius:10px;padding:8px 11px;font-size:10px;font-weight:900;cursor:pointer}.live-match:fullscreen{background:var(--paper);width:100vw;height:100vh;padding:7vh 12vw;display:grid;align-content:center}.live-match:fullscreen .live-points{font-size:clamp(72px,13vw,180px)}.live-match:fullscreen .live-team strong{font-size:clamp(22px,3vw,42px)}.live-match:fullscreen .pointbtn{font-size:clamp(16px,2vw,28px);padding:22px}.kbc-announcement{border-left:4px solid var(--green)}.kbc-announcement.alert{border-left-color:var(--warn)}.kbc-announcement p{white-space:pre-wrap;line-height:1.55}.kbc-stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}.kbc-stat{border:1px solid var(--line);border-radius:12px;padding:12px}.kbc-stat small,.kbc-stat strong{display:block}.kbc-stat small{color:var(--muted);font-size:8px;letter-spacing:1px}.kbc-stat strong{font-size:22px;margin-top:3px}.kbc-entry{border:1px solid var(--line);border-radius:12px;padding:12px}.kbc-match{border-top:1px solid var(--line);padding:12px 0;display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center}.kbc-match:first-child{border-top:0}.kbc-modal-grid{display:grid;gap:12px}.kbc-modal-grid label{display:flex;align-items:center;gap:10px;font-size:12px}.kbc-modal-grid input{width:18px;height:18px}.kbc-audit-json{max-width:280px;white-space:pre-wrap;word-break:break-word}.kbc-admin-tools{display:grid;gap:15px;margin-top:18px}.kbc-admin-tools textarea{min-height:100px}.kbc-admin-tools .actions{justify-content:flex-start}.kbc-role-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}.kbc-delete{color:var(--warn)}
      @media(max-width:800px){.kbc-stat-grid{grid-template-columns:repeat(2,1fr)}.kbc-match{grid-template-columns:1fr}.kbc-role-grid{grid-template-columns:1fr}.live-match:fullscreen{padding:5vh 5vw}}
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
    tools.innerHTML = `<div><p class="eyebrow">QUALITY TOOLS</p><h3>Club updates and permissions</h3><p class="kbc-muted">Publish an announcement or assign a focused admin role. The shared admin passcode remains the owner session.</p></div><form id="kbcAnnouncementForm"><div class="formgrid"><label><span class="label">TITLE</span><input class="control" name="title" required maxlength="160" placeholder="Thursday court update"></label><label><span class="label">TYPE</span><select class="control" name="kind"><option value="announcement">Announcement</option><option value="message">Message</option><option value="alert">Alert</option></select></label><label class="full"><span class="label">MESSAGE</span><textarea class="control" name="body" required maxlength="5000" placeholder="Write the note players should see."></textarea></label><label><span class="label">PIN TO TOP</span><input type="checkbox" name="pinned"></label></div><div class="actions"><button class="primary">Publish update</button></div></form><div><p class="eyebrow">ADMIN ROLES</p><div id="kbcRoles"></div></div>`;
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
    try { const result = await request()("admin-state", "GET", null, true); enhancement.adminRoles = result.roles || []; const players = result.players || []; target.innerHTML = `<div class="kbc-role-grid"><select class="control" id="kbcRolePlayer"><option value="">Choose player</option>${players.filter((player) => player.active).map((player) => `<option value="${player.id}">${esc(player.name)}</option>`).join("")}</select><select class="control" id="kbcRoleValue"><option>admin</option><option>treasurer</option><option>scheduler</option><option>scorekeeper</option><option>media</option><option>owner</option></select><button class="secondary" id="kbcSaveRole">Assign</button></div><div class="kbc-list">${enhancement.adminRoles.map((role) => `<div class="kbc-list-row"><span>${esc(players.find((player) => player.id === role.player_id)?.name || role.player_id)}</span><span class="kbc-chip">${role.role}</span></div>`).join("")}</div>`; $("kbcSaveRole").onclick = async () => { if (!$('kbcRolePlayer').value) return notify("Choose a player"); try { await request()("admin-set-role", "POST", { playerId: $('kbcRolePlayer').value, role: $('kbcRoleValue').value }, true); notify("Admin role saved"); renderAdminRoles(); } catch (error) { notify(error.message); } }; } catch (error) { target.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  }

  function renderAuditEnhancements() {
    const panel = $("auditLogPanel");
    const logs = (() => { try { return window.eval("adminAuditLogs") || []; } catch { return []; } })();
    if (!panel || !logs.length || panel.querySelector("#kbcAuditSnapshots")) return;
    const reversible = logs.filter((log) => log.before_data && !log.reverted_at).slice(0, 20);
    const section = document.createElement("article");
    section.id = "kbcAuditSnapshots";
    section.className = "card kbc-enhancement";
    section.innerHTML = `<p class="eyebrow">BEFORE AND AFTER</p><h3>Reversible change history</h3><p class="kbc-muted">Use Revert only when the earlier value should be restored.</p><div class="kbc-list">${reversible.length ? reversible.map((log) => `<div class="kbc-list-row"><div><strong>${esc(log.action)}</strong><p class="kbc-muted">${esc(log.target_type)} · ${new Date(log.created_at).toLocaleString("en-AU")}</p><details><summary>View snapshot</summary><div class="kbc-audit-json"><strong>Before</strong> ${esc(JSON.stringify(log.before_data, null, 2))}<br><strong>After</strong> ${esc(JSON.stringify(log.after_data, null, 2))}</div></details></div><button class="secondary kbc-delete" data-kbc-revert="${log.id}">Revert</button></div>`).join("") : `<p class="kbc-muted">No reversible changes are available.</p>`}</div>`;
    panel.appendChild(section);
    section.querySelectorAll("[data-kbc-revert]").forEach((button) => button.onclick = async () => { if (!confirm("Restore the before snapshot for this action?")) return; try { await request()("admin-revert-audit", "POST", { auditId: button.dataset.kbcRevert }, true); notify("Change reverted"); refresh(); } catch (error) { notify(error.message); } });
  }

  function enhanceRender() {
    injectStyles();
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

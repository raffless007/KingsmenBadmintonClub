/* Shared client platform: network state, safe refreshes, accessibility, and mobile polish. */
(function () {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const platform = window.kbcPlatform = window.kbcPlatform || {
    lastSyncedAt: null,
    pendingRequests: 0,
    refreshPromise: null,
    editingUntil: 0,
  };

  const isApi = (input) => String(typeof input === "string" ? input : input?.url || "").includes("/.netlify/functions/api");
  const methodOf = (input, init) => String(init?.method || input?.method || "GET").toUpperCase();
  const showStatus = (message, tone = "neutral") => {
    const bar = document.getElementById("kbcSyncStatus");
    if (!bar) return;
    bar.textContent = message;
    bar.dataset.tone = tone;
    bar.classList.toggle("hidden", !message);
  };

  function ensureStatusBar() {
    if (document.getElementById("kbcSyncStatus") || !document.body) return;
    const bar = document.createElement("div");
    bar.id = "kbcSyncStatus";
    bar.className = "kbc-sync-status hidden";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    document.body.appendChild(bar);
  }

  async function requestWithTimeout(input, init, timeoutMs) {
    if (init?.signal || typeof AbortController === "undefined") return nativeFetch(input, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await nativeFetch(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  window.fetch = async function guardedFetch(input, init = {}) {
    const apiRequest = isApi(input);
    const method = methodOf(input, init);
    if (!apiRequest) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
    if (!headers.has("x-kbc-request-id")) headers.set("x-kbc-request-id", window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    const nextInit = { ...init, headers };
    platform.pendingRequests += 1;
    window.dispatchEvent(new CustomEvent("kbc:request-start", { detail: { method } }));
    let attempt = 0;
    try {
      while (true) {
        try {
          const response = await requestWithTimeout(input, nextInit, 18000);
          if (response.ok) {
            platform.lastSyncedAt = new Date();
            window.dispatchEvent(new CustomEvent("kbc:request-success", { detail: { method, status: response.status, url: String(input) } }));
            return response;
          }
          if (method === "GET" && response.status >= 500 && attempt === 0) { attempt += 1; await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
          window.dispatchEvent(new CustomEvent("kbc:request-error", { detail: { method, status: response.status, url: String(input) } }));
          return response;
        } catch (error) {
          if (method === "GET" && attempt === 0 && navigator.onLine !== false) { attempt += 1; await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
          window.dispatchEvent(new CustomEvent("kbc:request-error", { detail: { method, error } }));
          throw error;
        }
      }
    } finally {
      platform.pendingRequests = Math.max(0, platform.pendingRequests - 1);
      window.dispatchEvent(new CustomEvent("kbc:request-finish", { detail: { pending: platform.pendingRequests } }));
    }
  };

  platform.isEditing = () => Date.now() < platform.editingUntil || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  platform.pauseRefresh = (milliseconds = 6000) => { platform.editingUntil = Date.now() + milliseconds; };
  platform.safeRefresh = async () => {
    if (platform.refreshPromise) return platform.refreshPromise;
    const refresh = window.refresh;
    if (typeof refresh !== "function") return undefined;
    platform.refreshPromise = Promise.resolve().then(() => refresh()).finally(() => { platform.refreshPromise = null; });
    return platform.refreshPromise;
  };

  function formatSyncedAt() {
    return platform.lastSyncedAt ? `Updated ${platform.lastSyncedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Waiting for club data";
  }

  function installDomEnhancements() {
    ensureStatusBar();
    document.addEventListener("focusin", (event) => { if (event.target.matches?.("input,select,textarea,[contenteditable='true']")) platform.pauseRefresh(); });
    document.addEventListener("input", (event) => { if (event.target.matches?.("input,select,textarea,[contenteditable='true']")) platform.pauseRefresh(); });
    document.addEventListener("change", (event) => { if (event.target.matches?.("input,select,textarea,[contenteditable='true']")) platform.pauseRefresh(); });
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button && !button.disabled) button.classList.add("kbc-pressed");
    });
    window.addEventListener("offline", () => showStatus("You are offline. Changes will be queued where supported.", "warning"));
    window.addEventListener("online", () => { showStatus("Connection restored. Syncing…", "success"); platform.safeRefresh().catch(() => {}); });
    window.addEventListener("kbc:request-success", (event) => {
      if (event.detail?.method === "GET") {
        showStatus(formatSyncedAt(), "success");
        setTimeout(() => { if (navigator.onLine !== false && !platform.pendingRequests) showStatus(""); }, 2200);
      }
    });
    window.addEventListener("kbc:request-error", (event) => {
      if (event.detail?.method === "GET" || event.detail?.status >= 500) showStatus("Could not sync with the clubhouse. Retry when ready.", "danger");
    });
    window.addEventListener("error", (event) => { if (event.error) console.error("Kingsmen UI error", event.error); });
    window.addEventListener("unhandledrejection", (event) => { console.error("Kingsmen async error", event.reason); });
    const labelMap = { "#installApp": "Add Shortcut to Home Screen", "#copyEoi": "Copy attendance list for WhatsApp" };
    Object.entries(labelMap).forEach(([selector, label]) => { const element = document.querySelector(selector); if (element) element.title = label; });
    ["#liveScores", "#scoreList", "#pairingSection", "#scheduleSection"].forEach((selector) => { const element = document.querySelector(selector); if (element) element.setAttribute("aria-live", "polite"); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installDomEnhancements, { once: true });
  else installDomEnhancements();
})();

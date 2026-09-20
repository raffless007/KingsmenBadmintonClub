const CACHE_NAME = "kingsmen-badminton-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.json", "/design-system.css", "/platform.js", "/enhancements.js", "/assets/kingsmen-logo.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/.netlify/functions/") || url.pathname.startsWith("/rest/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && url.origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match("/index.html"))));
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || "You have a new club update." };
  }

  event.waitUntil(self.registration.showNotification(data.title || "Kingsmen Badminton", {
    body: data.body || "You have a new Kingsmen Badminton update.",
    icon: "/assets/kingsmen-logo.png",
    badge: "/assets/kingsmen-logo.png",
    tag: data.tag || "kingsmen-update",
    renotify: Boolean(data.urgent),
    requireInteraction: Boolean(data.urgent),
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
    for (const client of clientList) {
      if ("navigate" in client) client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
    return undefined;
  }));
});

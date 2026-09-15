const CACHE_NAME = "kingsmen-badminton-shell-v1";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
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

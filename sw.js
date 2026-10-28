// Kiko's Walks service worker: shows a notification when someone logs a walk.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    const payload = event.data.json(); // FCM wraps our fields in `data`
    msg = payload.data || payload.notification || payload;
  } catch { /* show the default below */ }

  // Always show something: iOS revokes push for silent pushes.
  event.waitUntil(
    self.registration.showNotification(msg.title || "Kiko's Walks 🐾", {
      body: msg.body || "Kiko just went out",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "kiko-walk",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  })());
});

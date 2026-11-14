// Quadit's service worker. It does two things and nothing else:
//
//  1. shows push notifications and opens the right page when one is tapped;
//  2. keeps the built files (/assets/*, whose names carry a hash of their
//     content, and the fonts among them) so the app starts fast.
//
// It never answers for the API, files, hooks or pages: everything the app
// shows is live data and always comes from the server.

const CACHE = "quadit-assets-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** Only built files with a hashed name: the same address always holds the same bytes. */
function isBuiltAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/assets/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Not handled here: the browser asks the server as if there were no worker.
  if (!isBuiltAsset(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") cache.put(request, response.clone());
      return response;
    })(),
  );
});

// A push carries {title, body, url, tag} as JSON.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const title = message.title || "Quadit";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || "",
      // The same task or page replaces its earlier notification instead of stacking.
      tag: message.tag || undefined,
      data: { url: message.url || "/" },
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  // Only ever open this install's own pages.
  const href = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if (open.url !== href && "navigate" in open) await open.navigate(href).catch(() => self.clients.openWindow(href));
        return;
      }
      await self.clients.openWindow(href);
    })(),
  );
});

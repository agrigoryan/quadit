// Quadit's service worker. It does three things and nothing else:
//
//  1. shows push notifications and opens the right page when one is tapped;
//  2. keeps the built files (/assets/*, whose names carry a hash of their
//     content, and the fonts among them) so the app starts fast: for these,
//     and only these, the kept copy is used without asking the server;
//  3. keeps the last page it was served (and the few small files the page
//     names without a hash), to show when the server cannot be reached.
//
// The page itself always comes from the server when the server answers, and
// is checked with it even if the browser holds a copy: after a deploy the
// next load gets the new page, never a kept one. The kept page is used only
// when the request fails outright or a gateway says the server is away.
//
// It never answers for the API, files, hooks or sign-in: everything the app
// shows is live data and always comes from the server.

const ASSETS = "quadit-assets-v2";
const SHELL = "quadit-shell-v1";
/** Kept built files beyond this many are trimmed, oldest first (each deploy adds a set). */
const MAX_ASSETS = 400;

/** Never handled here: the browser asks the server as if there were no worker. */
const NOT_OURS = [
  "/api/",
  "/f/",
  "/mcp",
  "/oauth/",
  "/.well-known/",
  "/hooks/",
  "/desktop/finish",
  "/healthz",
  "/readyz",
  "/metrics",
  "/sw.js",
];
/** What the page names without a hash. */
const SHELL_FILES = ["/theme.js", "/manifest.webmanifest", "/quadit.svg"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== ASSETS && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

const isHtml = (response) => (response.headers.get("Content-Type") || "").includes("text/html");
const serverAway = (response) => response.status >= 502 && response.status <= 504;

/** A built file with a hashed name: the same address always holds the same bytes, so a kept copy is as good. */
async function builtAsset(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // A name the server no longer has is answered with the page; that is not the file.
  if (response.ok && response.type === "basic" && !isHtml(response)) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(old);
  }
  return response;
}

/** Asks the server first, always; the kept copy (under `key`) only when the server cannot be reached. */
async function serverFirst(request, key, keep) {
  const cache = await caches.open(SHELL);
  let response;
  try {
    // "no-cache": check with the server even when the browser holds a copy.
    response = await fetch(request, { cache: "no-cache" });
  } catch (err) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw err;
  }
  if (serverAway(response)) return (await cache.match(key)) || response;
  if (response.ok && response.type === "basic" && keep(response)) await cache.put(key, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (NOT_OURS.some((prefix) => path.startsWith(prefix))) return;
  if (path.startsWith("/assets/")) {
    event.respondWith(builtAsset(request));
  } else if (request.mode === "navigate") {
    // Every address of the app is the same document: one copy is kept for all.
    event.respondWith(serverFirst(request, "/", isHtml));
  } else if (SHELL_FILES.includes(path) || path.startsWith("/icons/")) {
    event.respondWith(serverFirst(request, path, (response) => !isHtml(response)));
  }
  // Anything else is not handled.
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
        if (open.url !== href && "navigate" in open)
          await open.navigate(href).catch(() => self.clients.openWindow(href));
        return;
      }
      await self.clients.openWindow(href);
    })(),
  );
});

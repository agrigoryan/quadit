// The service worker (public/sw.js) shows push notifications and keeps the
// built files for quick starts. It is registered once, when the app loads.

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the service worker, or returns the registration made earlier. Null when the browser has none. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  registration ??= navigator.serviceWorker.register("/sw.js").catch(() => null);
  return registration;
}

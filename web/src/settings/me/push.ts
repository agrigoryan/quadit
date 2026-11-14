// Push notifications on this device. The browser gives a subscription (an
// address at its maker's push service plus keys); the server keeps it and
// sends to it. Nothing here caches or reads what is pushed: public/sw.js
// shows the notification.

import { registerServiceWorker } from "@/auth/pwa";
import { fromBase64Url } from "@/auth/webauthn";
import { api } from "@/lib/api";

/** unsupported: this browser cannot; blocked: the person said no in the browser; off / on: for this device. */
export type PushState = "unsupported" | "blocked" | "off" | "on";

const SUBSCRIPTIONS = "/api/v1/push/subscriptions";

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await registerServiceWorker();
  if (!reg) return "unsupported";
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Asks the person, subscribes this browser and tells the server. Returns the new state. */
export async function turnPushOn(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  const reg = await registerServiceWorker();
  if (!reg) return "unsupported";
  const { public_key } = await api.get<{ public_key: string }>("/api/v1/push/key");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(fromBase64Url(public_key)) });
  await api.post(SUBSCRIPTIONS, sub.toJSON());
  return "on";
}

export async function turnPushOff(): Promise<PushState> {
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api.del(SUBSCRIPTIONS, { endpoint });
  }
  return "off";
}

/** Asks the server to push a sample to every device of mine with push on. Resolves with how many it reached. */
export const sendTestPush = () => api.post<{ sent: number }>("/api/v1/push/test").then((r) => r.sent);

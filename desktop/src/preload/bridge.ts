// The preload of a server's window. It runs again for every page the window
// loads, and gives the page window.quaditDesktop only when the page is the
// server's own origin: a page anywhere else (an error page, or anything
// that got past the navigation rules) gets nothing. A message is sent only
// in the shape the app keeps (shared/bridge.ts), so a page cannot make the
// app copy megabytes across. The main process checks the sender and the
// shape of every message again, so this is the first of two locks. A
// request the app sends (src/main/requests.ts) goes to the page's one
// handler, and its answer back in the outcome's shape.
//
// Sandboxed: only `electron`'s renderer modules are here, no Node.

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_BADGE,
  BRIDGE_LISTENING,
  BRIDGE_NOTIFY,
  BRIDGE_OPEN_CONNECT,
  BRIDGE_ORIGIN,
  BRIDGE_OUTCOME,
  BRIDGE_PUBLISH,
  BRIDGE_REQUEST,
  badgeOf,
  type DesktopNotification,
  type DesktopOutcome,
  type DesktopRequest,
  notificationOf,
  outcomeOf,
  type QuaditDesktop,
  summaryOf,
  VERSION_SWITCH,
} from "@/shared/bridge";

function switchValue(prefix: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

// Asked of the main process, which knows the server of every window it made (server-windows.ts).
const origin: unknown = ipcRenderer.sendSync(BRIDGE_ORIGIN);

if (typeof origin === "string" && origin && window.location.origin === origin) {
  // The page's one request handler, set by onRequest.
  let handler: ((request: DesktopRequest) => Promise<DesktopOutcome>) | null = null;
  ipcRenderer.on(BRIDGE_REQUEST, (_event, { id, request }: { id: string; request: DesktopRequest }) => {
    const answer = (outcome: DesktopOutcome) => ipcRenderer.send(BRIDGE_OUTCOME, { id, outcome });
    const handle = handler;
    if (!handle) return answer({ ok: false, message: "The page does not take requests now." });
    Promise.resolve()
      .then(() => handle(request))
      .then(
        (outcome) =>
          answer(outcomeOf(outcome) ?? { ok: false, message: "The page gave no answer the app understands." }),
        (err: unknown) =>
          answer({ ok: false, message: String(err instanceof Error ? err.message : err).slice(0, 500) }),
      )
      .catch(() => {}); // Sending failed: the app is going, and gives up on the answer itself.
  });

  const bridge: QuaditDesktop = {
    version: switchValue(VERSION_SWITCH),
    notify(n: DesktopNotification) {
      // Only plain strings cross: whatever else the page passed stays behind
      // (notificationOf makes the actions and the reply anew, of strings only).
      const notification = notificationOf({
        title: String(n?.title ?? ""),
        body: String(n?.body ?? ""),
        path: String(n?.path ?? "/"),
        tag: n?.tag === undefined ? undefined : String(n.tag),
        id: n?.id === undefined ? undefined : String(n.id),
        actions: n?.actions,
        reply: n?.reply,
      });
      if (notification) ipcRenderer.send(BRIDGE_NOTIFY, notification);
    },
    setBadge(count: number, workspace?: string) {
      const badge = badgeOf({ count: Number(count), workspace: String(workspace ?? "") });
      if (badge) ipcRenderer.send(BRIDGE_BADGE, badge);
    },
    publish(summary: unknown) {
      if (summary === null) return ipcRenderer.send(BRIDGE_PUBLISH, null);
      const kept = summaryOf(summary);
      if (kept) ipcRenderer.send(BRIDGE_PUBLISH, kept);
    },
    onRequest(handle: (request: DesktopRequest) => Promise<DesktopOutcome>) {
      if (typeof handle !== "function") throw new TypeError("onRequest takes a function");
      handler = handle;
      ipcRenderer.send(BRIDGE_LISTENING, true);
      return () => {
        if (handler !== handle) return;
        handler = null;
        ipcRenderer.send(BRIDGE_LISTENING, false);
      };
    },
    // Connect needs the quadit command, which has no Windows build: there the page offers nothing.
    ...(process.platform === "win32"
      ? {}
      : {
          openConnect() {
            ipcRenderer.send(BRIDGE_OPEN_CONNECT);
          },
        }),
  };
  contextBridge.exposeInMainWorld("quaditDesktop", Object.freeze(bridge));
}

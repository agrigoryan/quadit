// The preload of a server's window. It runs again for every page the window
// loads, and gives the page window.quaditDesktop only when the page is the
// server's own origin: a page anywhere else (an error page, or anything
// that got past the navigation rules) gets nothing. A message is sent only
// in the shape the app keeps (shared/bridge.ts), so a page cannot make the
// app copy megabytes across. The main process checks the sender and the
// shape of every message again, so this is the first of two locks.
//
// Sandboxed: only `electron`'s renderer modules are here, no Node.

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_BADGE,
  BRIDGE_NOTIFY,
  badgeOf,
  type DesktopNotification,
  notificationOf,
  ORIGIN_SWITCH,
  type QuaditDesktop,
  VERSION_SWITCH,
} from "@/shared/bridge";

function switchValue(prefix: string): string {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

const origin = switchValue(ORIGIN_SWITCH);

if (origin && window.location.origin === origin) {
  const bridge: QuaditDesktop = {
    version: switchValue(VERSION_SWITCH),
    notify(n: DesktopNotification) {
      // Only plain strings cross: whatever else the page passed stays behind.
      const notification = notificationOf({
        title: String(n?.title ?? ""),
        body: String(n?.body ?? ""),
        path: String(n?.path ?? "/"),
        tag: n?.tag === undefined ? undefined : String(n.tag),
        id: n?.id === undefined ? undefined : String(n.id),
      });
      if (notification) ipcRenderer.send(BRIDGE_NOTIFY, notification);
    },
    setBadge(count: number, workspace?: string) {
      const badge = badgeOf({ count: Number(count), workspace: String(workspace ?? "") });
      if (badge) ipcRenderer.send(BRIDGE_BADGE, badge);
    },
  };
  contextBridge.exposeInMainWorld("quaditDesktop", Object.freeze(bridge));
}

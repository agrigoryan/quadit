// The preload of a server's window. It runs again for every page the window
// loads, and gives the page window.quaditDesktop only when the page is the
// server's own origin: a page anywhere else (an error page, or anything
// that got past the navigation rules) gets nothing. The main process checks
// the sender of every message again, so this is the first of two locks.
//
// Sandboxed: only `electron`'s renderer modules are here, no Node.

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_BADGE,
  BRIDGE_NOTIFY,
  type DesktopNotification,
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
      ipcRenderer.send(BRIDGE_NOTIFY, {
        title: String(n?.title ?? ""),
        body: String(n?.body ?? ""),
        path: String(n?.path ?? "/"),
        tag: n?.tag === undefined ? undefined : String(n.tag),
        id: n?.id === undefined ? undefined : String(n.id),
      });
    },
    setBadge(count: number, workspace?: string) {
      ipcRenderer.send(BRIDGE_BADGE, { count: Number(count), workspace: String(workspace ?? "") });
    },
  };
  contextBridge.exposeInMainWorld("quaditDesktop", Object.freeze(bridge));
}

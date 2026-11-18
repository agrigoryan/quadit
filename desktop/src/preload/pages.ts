// The preload of the app's own bundled pages (the server list and the
// sign-in bar): window.quaditPages, each method one IPC call. The main
// process answers only frames loaded from the app's own files.
//
// Sandboxed: only `electron`'s renderer modules are here, no Node.

import { contextBridge, ipcRenderer } from "electron";
import { PAGES_CHANGED, PAGES_CHANNEL, type PagesApi } from "@/shared/pages-api";

const call =
  <K extends keyof PagesApi>(name: K) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(PAGES_CHANNEL + name, ...args);

const api: PagesApi = {
  listServers: call("listServers"),
  checkServer: call("checkServer"),
  addServer: call("addServer"),
  removeServer: call("removeServer"),
  openServer: call("openServer"),
  signIn: call("signIn"),
  takeInvitation: call("takeInvitation"),
  onChanged(listener) {
    ipcRenderer.on(PAGES_CHANGED, () => listener());
  },
  dismissSignInBar() {
    void ipcRenderer.invoke(PAGES_CHANNEL + "dismissSignInBar");
  },
};

contextBridge.exposeInMainWorld("quaditPages", api);

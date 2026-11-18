// The preload of the app's own bundled pages (shared/pages-api.ts names
// them): window.quaditPages, each method one IPC call. The main
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
  summaries: call("summaries"),
  openPath: call("openPath"),
  act: call("act"),
  capture: call("capture"),
  lastCapture: call("lastCapture"),
  setupState: call("setupState"),
  saveSetup: call("saveSetup"),
  testNotification: call("testNotification"),
  openNotificationSettings: call("openNotificationSettings"),
  openConnect: call("openConnect"),
  connectState: call("connectState"),
  planConnect: call("planConnect"),
  applyConnect: call("applyConnect"),
  planDisconnect: call("planDisconnect"),
  dropPlan: call("dropPlan"),
  applyDisconnect: call("applyDisconnect"),
  showBackups: call("showBackups"),
  onChanged(listener) {
    ipcRenderer.on(PAGES_CHANGED, () => listener());
  },
  dismissSignInBar() {
    void ipcRenderer.invoke(PAGES_CHANNEL + "dismissSignInBar");
  },
  retryServer() {
    void ipcRenderer.invoke(PAGES_CHANNEL + "retryServer");
  },
};

contextBridge.exposeInMainWorld("quaditPages", api);

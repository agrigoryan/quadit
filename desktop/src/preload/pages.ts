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
  localServer: call("localServer"),
  setUpHere: call("setUpHere"),
  connectServer: call("connectServer"),
  lookForTools: call("lookForTools"),
  connectTool: call("connectTool"),
  disconnectTool: call("disconnectTool"),
  toolChanges: call("toolChanges"),
  finishFirstRun: call("finishFirstRun"),
  endFirstRun: call("endFirstRun"),
  firstRunStep: call("firstRunStep"),
  controlLocalServer: call("controlLocalServer"),
  showLocalServerFiles: call("showLocalServerFiles"),
  setOpenAtLogin: call("setOpenAtLogin"),
  summaries: call("summaries"),
  openPath: call("openPath"),
  act: call("act"),
  fitPanel: call("fitPanel"),
  openCapture: call("openCapture"),
  openAgent: call("openAgent"),
  capture: call("capture"),
  lastCapture: call("lastCapture"),
  showWelcome: call("showWelcome"),
  accountName: call("accountName"),
  setupState: call("setupState"),
  saveSetup: call("saveSetup"),
  testNotification: call("testNotification"),
  openNotificationSettings: call("openNotificationSettings"),
  openConnect: call("openConnect"),
  connectTarget: call("connectTarget"),
  closeConnect: call("closeConnect"),
  toolHandshake: call("toolHandshake"),
  newConnectCode: call("newConnectCode"),
  updateSkill: call("updateSkill"),
  toolSelf: call("toolSelf"),
  showToolLog: call("showToolLog"),
  runEntries: call("runEntries"),
  agentProjects: call("agentProjects"),
  runWaiting: call("runWaiting"),
  pickFolder: call("pickFolder"),
  startRunning: call("startRunning"),
  stopRunning: call("stopRunning"),
  showRunnerLog: call("showRunnerLog"),
  copyText: call("copyText"),
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

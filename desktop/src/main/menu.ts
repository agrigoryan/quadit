// The application menu: the standard macOS one (and its Windows and Linux
// equivalent) plus a Servers part to switch windows.
//
// A key the web app uses is never given to a menu item here: Cmd+K, Cmd+[
// and Cmd+], Cmd+. and Cmd+Shift+., Cmd+Option+P, Cmd+Backspace, Cmd+B,
// Cmd+Shift+, and the rest of web/src (menu.test.ts holds the list). The
// Edit roles keep their keys (Cmd+Z, Cmd+Shift+Z, Cmd+A): text fields need
// them, and a key reaches the page before the menu, so where the web app
// takes Cmd+A or Cmd+Z for itself (preventDefault), the menu never sees it.

import type { MenuItemConstructorOptions } from "electron";
import type { Release } from "@/main/updates";
import type { LocalControl, LocalState } from "@/shared/pages-api";

export interface MenuState {
  appName: string;
  platform: NodeJS.Platform;
  /** Developer tools are offered only when the app runs from source. */
  dev: boolean;
  servers: { id: string; name: string; focused: boolean }[];
  /** Whether the window in front is a server's (Sign In with Browser acts on it). */
  serverInFront: boolean;
  update: Release | null;
  /** The server the app can run on this computer; null where this build cannot run one. */
  local: {
    /** Whether it is in the server list. */
    setUp: boolean;
    state: LocalState["kind"];
    /** Whether the app starts at login; null where the app does not offer it. */
    openAtLogin: boolean | null;
  } | null;
}

export interface MenuActions {
  showServerList(): void;
  showSetup(): void;
  showConnect(): void;
  quickCapture(): void;
  togglePanel(): void;
  openServer(serverId: string): void;
  signInInFront(): void;
  openUpdate(release: Release): void;
  openWebsite(): void;
  reportIssue(): void;
  runLocalServer(): void;
  controlLocalServer(control: LocalControl): void;
  showLocalServerFiles(what: "data" | "log"): void;
  setOpenAtLogin(on: boolean): void;
}

/** What the menu-bar panel is called where it is a menu item. */
export const PANEL_LABEL = "Decisions and Agents";

/** What the menu says each state of the server on this computer is. */
const LOCAL_STATE_LABEL: Record<LocalState["kind"], string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  failed: "Failed",
};

/** Running Quadit on this computer, or the controls of the server that runs here. */
function localItems(local: MenuState["local"], actions: MenuActions): MenuItemConstructorOptions[] {
  if (!local) return [];
  if (!local.setUp)
    return [{ id: "run-local", label: "Run Quadit on This Computer…", click: () => actions.runLocalServer() }];
  const up = local.state === "starting" || local.state === "running";
  return [
    {
      id: "local",
      label: "Server on This Computer",
      submenu: [
        { label: LOCAL_STATE_LABEL[local.state], enabled: false },
        { type: "separator" },
        { id: "local-start", label: "Start", enabled: !up, click: () => actions.controlLocalServer("start") },
        { id: "local-stop", label: "Stop", enabled: up, click: () => actions.controlLocalServer("stop") },
        {
          id: "local-restart",
          label: "Restart",
          enabled: local.state === "running",
          click: () => actions.controlLocalServer("restart"),
        },
        { type: "separator" },
        { id: "local-data", label: "Show Data Folder", click: () => actions.showLocalServerFiles("data") },
        { id: "local-log", label: "Show Log", click: () => actions.showLocalServerFiles("log") },
        ...(local.openAtLogin === null
          ? []
          : [
              { type: "separator" as const },
              {
                id: "login-item",
                label: "Start Quadit When I Log In",
                type: "checkbox" as const,
                checked: local.openAtLogin,
                click: () => actions.setOpenAtLogin(!local.openAtLogin),
              },
            ]),
      ],
    },
  ];
}

export function menuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = state.platform === "darwin";
  const setup: MenuItemConstructorOptions = {
    id: "setup",
    label: `Set Up ${state.appName}…`,
    click: () => actions.showSetup(),
  };
  const update: MenuItemConstructorOptions[] = state.update
    ? [
        {
          label: `${state.appName} ${state.update.version} Is Available…`,
          click: () => state.update && actions.openUpdate(state.update),
        },
      ]
    : [];

  const appMenu: MenuItemConstructorOptions = {
    label: state.appName,
    submenu: [
      { role: "about" },
      ...(update.length ? [{ type: "separator" as const }, ...update] : []),
      { type: "separator" },
      setup,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { id: "servers", label: "Servers…", click: () => actions.showServerList() },
      { label: "Add Server…", click: () => actions.showServerList() },
      ...localItems(state.local, actions),
      { type: "separator" },
      // The key is the global one quick capture takes itself (capture.ts), so it is not given here.
      { id: "quick-capture", label: "Quick Capture…", click: () => actions.quickCapture() },
      { id: "connect", label: "Connect Agents…", click: () => actions.showConnect() },
      ...(mac ? [] : [setup]),
      { type: "separator" },
      { label: "Sign In with Browser…", enabled: state.serverInFront, click: () => actions.signInInFront() },
      { type: "separator" },
      { role: "close" },
      ...(mac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      ...(state.dev ? [{ role: "toggleDevTools" as const }] : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      ...(mac ? [{ role: "zoom" as const }] : []),
      { type: "separator" },
      ...state.servers.map((server, i): MenuItemConstructorOptions => ({
        label: server.name,
        type: "checkbox",
        checked: server.focused,
        // Cmd+1 to Cmd+9, as browsers switch tabs; the web app leaves them free.
        accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
        click: () => actions.openServer(server.id),
      })),
      ...(state.servers.length ? [{ type: "separator" as const }] : []),
      { label: "Servers…", click: () => actions.showServerList() },
      { id: "panel", label: PANEL_LABEL, click: () => actions.togglePanel() },
      ...(mac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      { label: `${state.appName} Website`, click: () => actions.openWebsite() },
      { label: "Report an Issue…", click: () => actions.reportIssue() },
      // On macOS the notice sits in the app menu; elsewhere there is none.
      ...(mac || !update.length ? [] : [{ type: "separator" as const }, ...update]),
    ],
  };

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

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

export interface MenuState {
  appName: string;
  platform: NodeJS.Platform;
  /** Developer tools are offered only when the app runs from source. */
  dev: boolean;
  servers: { id: string; name: string; focused: boolean }[];
  /** Whether the window in front is a server's (Sign In with Browser acts on it). */
  serverInFront: boolean;
  update: Release | null;
}

export interface MenuActions {
  showServerList(): void;
  openServer(serverId: string): void;
  signInInFront(): void;
  openUpdate(release: Release): void;
  openWebsite(): void;
  reportIssue(): void;
}

export function menuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = state.platform === "darwin";
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
      { label: "Servers…", click: () => actions.showServerList() },
      { label: "Add Server…", click: () => actions.showServerList() },
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

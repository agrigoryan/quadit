import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { menuTemplate, type MenuState } from "@/main/menu";

/**
 * The modifier keys the web app takes for itself (web/src: useHotkeys and the
 * editors), in Electron's accelerator words. None may be a menu item's key.
 */
const PAGE_KEYS = [
  "CmdOrCtrl+K",
  "CmdOrCtrl+[",
  "CmdOrCtrl+]",
  "CmdOrCtrl+.",
  "CmdOrCtrl+Shift+.",
  "CmdOrCtrl+Alt+P",
  "CmdOrCtrl+Backspace",
  "CmdOrCtrl+Delete",
  "CmdOrCtrl+B",
  "CmdOrCtrl+I",
  "CmdOrCtrl+Shift+,",
  "CmdOrCtrl+Shift+O",
  "CmdOrCtrl+Shift+Up",
  "CmdOrCtrl+Shift+Down",
];

const state = (platform: NodeJS.Platform, extra: Partial<MenuState> = {}): MenuState => ({
  appName: "Quadit",
  platform,
  dev: false,
  servers: [
    { id: "a", name: "Work", focused: true },
    { id: "b", name: "Home", focused: false },
  ],
  serverInFront: true,
  update: null,
  ...extra,
});

const noop = () => {};
const actions = {
  showServerList: noop,
  showSetup: noop,
  showConnect: noop,
  quickCapture: noop,
  togglePanel: noop,
  openServer: noop,
  signInInFront: noop,
  openUpdate: noop,
  openWebsite: noop,
  reportIssue: noop,
};

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

/** A key written one canonical way, so "CommandOrControl+k" and "CmdOrCtrl+K" compare equal. */
function canonical(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) =>
      part
        .toLowerCase()
        .replace(/^commandorcontrol$/, "cmdorctrl")
        .replace(/^option$/, "alt"),
    )
    .sort()
    .join("+");
}

describe("menuTemplate", () => {
  it("binds none of the web app's keys", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const bound = items(menuTemplate(state(platform, { dev: true }), actions)).flatMap((item) =>
        item.accelerator ? [canonical(String(item.accelerator))] : [],
      );
      for (const key of PAGE_KEYS) expect(bound, `${platform} ${key}`).not.toContain(canonical(key));
    }
  });

  it("has the standard macOS menus, with Edit roles so text fields can copy and paste", () => {
    const template = menuTemplate(state("darwin"), actions);
    expect(template.map((menu) => menu.label ?? menu.role)).toEqual([
      "Quadit",
      "File",
      "Edit",
      "View",
      "Window",
      "help",
    ]);
    const roles = items(template).map((item) => item.role);
    for (const role of [
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "quit",
      "hide",
      "close",
      "minimize",
      "front",
    ]) {
      expect(roles).toContain(role);
    }
  });

  it("offers developer tools only when run from source", () => {
    const roles = (dev: boolean) => items(menuTemplate(state("darwin", { dev }), actions)).map((item) => item.role);
    expect(roles(false)).not.toContain("toggleDevTools");
    expect(roles(true)).toContain("toggleDevTools");
  });

  it("lists the servers in the Window menu with Cmd+1, Cmd+2…, the one in front checked", () => {
    const windowMenu = menuTemplate(state("darwin"), actions).find((menu) => menu.label === "Window");
    const submenu = Array.isArray(windowMenu?.submenu) ? windowMenu.submenu : [];
    const servers = submenu.filter((item) => item.type === "checkbox");
    expect(servers.map((item) => [item.label, item.accelerator, item.checked])).toEqual([
      ["Work", "CmdOrCtrl+1", true],
      ["Home", "CmdOrCtrl+2", false],
    ]);
  });

  it("shows an available update in the app menu", () => {
    const labels = items(
      menuTemplate(state("darwin", { update: { version: "0.2.0", url: "https://x" } }), actions),
    ).map((item) => item.label);
    expect(labels).toContain("Quadit 0.2.0 Is Available…");
  });
});

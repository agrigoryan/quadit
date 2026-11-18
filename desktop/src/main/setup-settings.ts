// The app's own settings (settings.json in its data folder) and the setup
// page that shows them: at the first start, and again from the app menu
// (Set Up Quadit…). Setup walks through adding a server, signing in,
// notifications, connecting agents and the quick-capture key; every step
// can be skipped, and each shows where it stands.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { app, type BrowserWindow, Notification, shell } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { CaptureTarget, SetupState } from "@/shared/pages-api";

export interface AppSettings {
  /** Setup was finished or skipped: it no longer opens at the start. */
  setupDone: boolean;
  /** Whether quick capture has its global key. */
  captureShortcut: boolean;
  /** Where quick capture last put something. */
  lastCapture: CaptureTarget | null;
}

export class Settings {
  private current: AppSettings;

  /** Reads `file`; a missing or unreadable one is the defaults, so a first start and a damaged file both start clean. */
  constructor(private file: string) {
    this.current = readSettings(file);
  }

  get(): AppSettings {
    return this.current;
  }

  change(change: Partial<AppSettings>) {
    this.current = { ...this.current, ...change };
    mkdirSync(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    renameSync(next, this.file);
  }
}

function readSettings(file: string): AppSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) raw = parsed as Record<string, unknown>;
  } catch {
    // None yet, or unreadable: the defaults.
  }
  const last = raw.lastCapture as Partial<CaptureTarget> | undefined;
  const lastCapture =
    last &&
    typeof last.serverId === "string" &&
    typeof last.workspaceId === "string" &&
    (typeof last.project === "string" || last.project === null) &&
    (last.what === "task" || last.what === "page")
      ? { serverId: last.serverId, workspaceId: last.workspaceId, project: last.project, what: last.what }
      : null;
  return { setupDone: raw.setupDone === true, captureShortcut: raw.captureShortcut !== false, lastCapture };
}

export interface SetupParts {
  pages: AppPages;
  settings: Settings;
  /** The quick-capture key's name, and why it could not be taken (undefined when it was, or is off). */
  shortcut(): { accelerator: string; error?: string };
  /** Takes or lets go of the quick-capture key after its setting changed. */
  applyShortcut(): void;
  /** The servers a window has shown a workspace of. */
  signedIn(): string[];
  openConnect(): void;
}

export class Setup {
  private win: BrowserWindow | undefined;
  /** Held so that the test notification's click still arrives. */
  private test: Notification | undefined;

  constructor(private parts: SetupParts) {
    parts.pages.answer({
      setupState: () => this.state(),
      saveSetup: (_sender, raw) => {
        const { setupDone, captureShortcut } = (raw ?? {}) as Record<string, unknown>;
        parts.settings.change({
          ...(typeof setupDone === "boolean" ? { setupDone } : {}),
          ...(typeof captureShortcut === "boolean" ? { captureShortcut } : {}),
        });
        if (typeof captureShortcut === "boolean") parts.applyShortcut();
        return this.state();
      },
      testNotification: () => {
        this.test = new Notification({ title: app.name, body: "Notifications from your servers will look like this." });
        this.test.show();
      },
      openNotificationSettings: async () => {
        const address = NOTIFICATION_SETTINGS[process.platform];
        if (!address) return false;
        await shell.openExternal(address);
        return true;
      },
      openConnect: () => parts.openConnect(),
    });
  }

  /** Shows the setup page, making its window when there is none. */
  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = this.parts.pages.window("setup.html", {
      name: "setup",
      width: 600,
      height: 720,
      minWidth: 460,
      minHeight: 480,
      title: "Set Up Quadit",
    });
    // Closed is done: every step can be skipped, and setup stays in the app menu.
    this.win.on("closed", () => {
      this.win = undefined;
      this.parts.settings.change({ setupDone: true });
    });
  }

  private state(): SetupState {
    const { setupDone, captureShortcut } = this.parts.settings.get();
    const { accelerator, error } = this.parts.shortcut();
    return {
      setupDone,
      captureShortcut,
      shortcut: accelerator,
      ...(error ? { shortcutError: error } : {}),
      signedIn: this.parts.signedIn(),
    };
  }
}

/** Where each system keeps its notification settings. Linux desktops have no one address. */
const NOTIFICATION_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  win32: "ms-settings:notifications",
};

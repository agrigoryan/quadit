// The setup page and the settings it shows (settings.ts): at the first
// start, and again from the app menu (Set Up Quadit…). Setup walks through
// adding a server, signing in, notifications, connecting agents and the
// quick-capture key; every step can be skipped, and each shows where it
// stands.

import { app, type BrowserWindow, Notification, shell } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Settings } from "@/main/settings";
import type { SetupState } from "@/shared/pages-api";

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

// Welcome: the app's first page when it has no server yet (desktop
// contract §7), and where "Set Up on This Computer…" leads. Its main choice
// sets Quadit up on this computer with only the person's name (the server
// list does the work: server-list.ts, setUpHere); the small one connects to
// a server elsewhere through the server list's address form and the
// browser sign-in. Closed, the first run is over: setup no longer opens at
// the start, and the checklist stays in the menu.

import type { BrowserWindow } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Settings } from "@/main/settings";

export interface WelcomeParts {
  pages: AppPages;
  settings: Settings;
  /** The full name of the person's account on this computer (account-name.ts). */
  accountName(): Promise<string>;
}

export class Welcome {
  private win: BrowserWindow | undefined;

  constructor(private parts: WelcomeParts) {
    parts.pages.answer({
      showWelcome: () => this.show(),
      accountName: () => parts.accountName(),
    });
  }

  /** Shows Welcome, making its window when there is none. */
  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = this.parts.pages.window("welcome.html", {
      name: "welcome",
      width: 520,
      height: 620,
      minWidth: 420,
      minHeight: 520,
      title: "Welcome to Quadit",
    });
    this.win.on("closed", () => {
      this.win = undefined;
      this.parts.settings.change({ setupDone: true });
    });
  }
}

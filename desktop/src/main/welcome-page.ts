// Welcome: the app's first page when it has no server yet (desktop
// contract §7), and where "Set Up on This Computer…" leads. Its main choice
// sets Quadit up on this computer with only the person's name (the server
// list does the work: server-list.ts, setUpHere), and then, where agent
// tools are found here, offers to connect them (§8: first-connect.ts); the
// small one connects to a server elsewhere through the server list's
// address form and the browser sign-in. Closed, the first run is over:
// Welcome no longer opens at the start, its tools step is gone for good,
// and the checklist and Connect Agents… stay in the menu.

import type { BrowserWindow } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { FirstConnect } from "@/main/first-connect";
import type { ServerList } from "@/main/server-list";
import type { Settings } from "@/main/settings";

export interface WelcomeParts {
  pages: AppPages;
  settings: Settings;
  /** The full name of the person's account on this computer (account-name.ts). */
  accountName(): Promise<string>;
  list: Pick<ServerList, "setUpHere">;
  firstConnect: FirstConnect;
}

export class Welcome {
  private win: BrowserWindow | undefined;

  constructor(private parts: WelcomeParts) {
    const { firstConnect } = parts;
    parts.pages.answer({
      showWelcome: () => this.show(),
      accountName: () => parts.accountName(),
      setUpHere: (_sender, name) => this.setUpHere(typeof name === "string" ? name : ""),
      connectFoundTool: (_sender, id) => firstConnect.connect(String(id)),
      foundToolChanges: (_sender, id) => firstConnect.changes(String(id)),
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
      width: 560,
      height: 660,
      minWidth: 420,
      minHeight: 520,
      title: "Welcome to Quadit",
    });
    this.win.on("closed", () => {
      this.win = undefined;
      this.parts.firstConnect.end();
      this.parts.settings.change({ setupDone: true });
    });
  }

  /**
   * Sets Quadit up on this computer, whose window opens on the workspace;
   * gives the agent tools the step offers next, which only a workspace made
   * just now has (none: Welcome is done). Welcome stays in front for them.
   */
  private async setUpHere(
    name: string,
  ): Promise<{ ok: true; tools: { id: string; name: string }[] } | { ok: false; error: string }> {
    const done = await this.parts.list.setUpHere(name);
    if (!done.ok) return done;
    const tools = done.workspace ? await this.parts.firstConnect.begin(done.serverId, done.workspace) : [];
    if (tools.length > 0) this.show();
    return { ok: true, tools };
  }
}

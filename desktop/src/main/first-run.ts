// The first run (desktop contract §10): from the first launch to the
// workspace, in one window. Its page (src/pages/first-run.html) is laid over
// a server window (ServerWindows.cover): the window made for the server
// about to be added, or, when the server on this computer is in the list
// with its set-up unfinished, that server's own. Its steps:
//   1. Welcome: "Set up on this computer" with the person's name (the server
//      list does the work: server-list.ts, setUpHere), whose workspace then
//      loads under the page; or "Connect to a server instead", whose window
//      that one becomes, on its sign-in page, which ends the first run.
//   2. Connect your AI tools (first-connect.ts), after a set-up here, always.
//   Continue or Skip makes the sample tasks, shows the workspace on them, and
//   ends the first run. Ended, by the page or by closing its window, it is
//   over for good: the app no longer starts with it (settings: setupDone),
//   and it comes back only when the person asks ("Set Up on This Computer…").
//
// The page is an app page in a view of its own, in the app's session: it gets
// the pages API and never the bridge, and the server's page under it, in its
// own web contents and partition, never gets the pages API.

import type { WebContentsView } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { FirstConnect } from "@/main/first-connect";
import type { ServerList } from "@/main/server-list";
import type { ServerWindows } from "@/main/server-windows";
import type { Settings } from "@/main/settings";

export interface FirstRunParts {
  pages: Pick<AppPages, "answer" | "view">;
  settings: Settings;
  /** The full name of the person's account on this computer (account-name.ts). */
  accountName(): Promise<string>;
  list: Pick<ServerList, "setUpHere" | "add" | "localServer">;
  windows: Pick<ServerWindows, "cover" | "uncover" | "show">;
  firstConnect: FirstConnect;
}

export class FirstRun {
  /** The page and the id of the server whose window it covers (or the one about to be added); none when not running. */
  private shown: { view: WebContentsView; serverId: string } | undefined;

  constructor(private parts: FirstRunParts) {
    const { firstConnect } = parts;
    parts.pages.answer({
      showWelcome: () => this.show(),
      accountName: () => parts.accountName(),
      setUpHere: (_sender, name) => this.setUpHere(typeof name === "string" ? name : ""),
      connectServer: (_sender, address, allowInsecure) => this.connectServer(String(address), allowInsecure === true),
      lookForTools: () => firstConnect.look(),
      connectTool: (_sender, id) => firstConnect.connect(String(id)),
      disconnectTool: (_sender, id) => firstConnect.disconnect(String(id)),
      toolChanges: (_sender, id) => firstConnect.changes(String(id)),
      finishFirstRun: () => this.finish(),
      endFirstRun: () => this.end(),
    });
  }

  /** Starts the first run on its Welcome, or brings its window to the front when it is running. */
  show() {
    const { pages, windows, list } = this.parts;
    if (this.shown) {
      windows.cover(this.shown.view, null, () => this.end());
      return;
    }
    const view = pages.view("first-run.html");
    // Over the window of the server on this computer when it is in the list (its set-up unfinished), else over a
    // window made for the server the person is about to set up or add.
    const serverId = windows.cover(view, list.localServer()?.id ?? null, () => this.end());
    this.shown = { view, serverId };
  }

  /** Sets Quadit up on this computer in the first run's window, which then shows its workspace under the tools step. */
  private async setUpHere(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.shown) return { ok: false, error: "The first run is over: set Quadit up from the menu." };
    const done = await this.parts.list.setUpHere(name, this.shown.serverId);
    if (!done.ok) return done;
    this.parts.firstConnect.begin(done.serverId, done.workspace);
    return { ok: true };
  }

  /** Adds a server elsewhere, whose window the first run's becomes, on its sign-in page: the first run is over. */
  private async connectServer(address: string, allowInsecure: boolean) {
    const added = await this.parts.list.add(address, "", allowInsecure, this.shown?.serverId);
    if (added.ok) this.end();
    return added;
  }

  /** The tools step is done: the sample tasks are made, and the window goes to them, under the page. */
  private async finish() {
    const shown = this.shown;
    const path = await this.parts.firstConnect.finish();
    if (shown && path) this.parts.windows.show(shown.serverId, path);
  }

  /** The first run is over: its page goes, the window under it stays, and the app no longer starts with it. */
  private end() {
    if (!this.shown) return;
    this.shown = undefined;
    this.parts.firstConnect.end();
    this.parts.windows.uncover();
    this.parts.settings.change({ setupDone: true });
  }
}

// The first run (desktop contract §10): from the first launch to the
// workspace, in one window. Its page (src/pages/first-run.html) is laid over
// a server window (ServerWindows.cover): the window made for the server
// about to be added, or, when the server on this computer is in the list
// with its set-up unfinished, that server's own. Its steps:
//   1. Welcome: "Set up on this computer" with the person's name (the server
//      list does the work: server-list.ts, setUpHere), whose workspace then
//      loads under the page; or "Connect to a server instead", whose window
//      that one becomes, on its sign-in page, which ends the first run.
//   2. Connect your AI tools (first-connect.ts), for an install this app has
//      just set up: one set up before, whose data was kept (re-added, or
//      restored under the app), opens on its workspace with nothing more.
//   Continue or Skip makes the sample tasks, shows the workspace on them, and
//   ends the first run. Ended, by the page or by closing its window, it is
//   over for good: the app no longer starts with it (settings: setupDone),
//   and it comes back only when the person asks ("Set Up on This Computer…").
//   The app quitting during the tools step is no end: the step is owed
//   (settings: pendingFirstRun), and the next start resumes it.
//
// Each showing is one run, which owns what it began: work a run started that
// finishes after it ended (its window closed, a newer run shown) shows no
// window, begins no step and ends nothing.
//
// The page is an app page in a view of its own, in the app's session: it gets
// the pages API and never the bridge, and the server's page under it, in its
// own web contents and partition, never gets the pages API.

import type { WebContentsView } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { FirstConnect } from "@/main/first-connect";
import type { ServerList } from "@/main/server-list";
import type { ServerWindows } from "@/main/server-windows";
import type { ServerStore } from "@/main/servers";
import type { PendingFirstRun, Settings } from "@/main/settings";
import type { AddResult, Refused } from "@/shared/pages-api";

export interface FirstRunParts {
  pages: Pick<AppPages, "answer" | "view">;
  settings: Pick<Settings, "get" | "change">;
  store: Pick<ServerStore, "list" | "get">;
  /** The full name of the person's account on this computer (account-name.ts). */
  accountName(): Promise<string>;
  list: Pick<ServerList, "setUpHere" | "add" | "localServer">;
  windows: Pick<ServerWindows, "cover" | "uncover" | "openCoveredPath" | "showAfresh">;
  /** The tools step for the workspace `workspace` (its slug) of the server `serverId`. */
  toolsStep(serverId: string, workspace: string): FirstConnect;
}

/** One showing of the first run. */
interface Run {
  view: WebContentsView;
  /** The id a server added in this run takes, to take the window made for it; null over an existing server's window. */
  donor: string | null;
  /** The tools step, once this app has set the install up (or resumed one owed), with the person's name. */
  tools: { step: FirstConnect; person: string } | null;
}

const OVER: Refused = { ok: false, error: "The first run is over: set Quadit up from the menu." };

export class FirstRun {
  private run: Run | undefined;

  constructor(private parts: FirstRunParts) {
    const tools = () => this.run?.tools?.step;
    parts.pages.answer({
      showWelcome: () => this.show(),
      accountName: () => parts.accountName(),
      firstRunStep: () => {
        const person = this.run?.tools?.person;
        return person === undefined ? { step: "welcome" } : { step: "tools", person };
      },
      setUpHere: (_sender, name) => this.setUpHere(typeof name === "string" ? name : ""),
      connectServer: (_sender, address, allowInsecure) => this.connectServer(String(address), allowInsecure === true),
      lookForTools: () => tools()?.look() ?? OVER,
      connectTool: (_sender, id, planId) =>
        tools()?.connect(String(id), typeof planId === "string" ? planId : undefined) ?? OVER,
      disconnectTool: (_sender, id) => tools()?.disconnect(String(id)) ?? OVER,
      toolChanges: (_sender, id) => tools()?.changes(String(id)) ?? OVER,
      finishFirstRun: () => this.finish(),
      endFirstRun: () => this.end(),
    });
  }

  /**
   * Whether the app starts with the first run: on its very first start (no
   * server yet), and while a tools step is owed to a server still in the list.
   */
  due(): boolean {
    const { settings, store } = this.parts;
    const pending = settings.get().pendingFirstRun;
    if (pending) return !!store.get(pending.serverId);
    return !settings.get().setupDone && store.list().length === 0;
  }

  /**
   * Shows the first run, or brings its window to the front when it is
   * running: at its tools step when one is owed (over that server's window),
   * else on its Welcome.
   */
  show() {
    const { pages, windows, list, settings, store } = this.parts;
    if (this.run) {
      windows.cover(this.run.view, null, () => this.closed(this.run));
      return;
    }
    const pending = settings.get().pendingFirstRun;
    const owed = pending && store.get(pending.serverId) ? pending : null;
    const view = pages.view("first-run.html");
    const run: Run = { view, donor: null, tools: owed && this.toolsFor(owed) };
    this.run = run;
    // Over the window of the server the tools step is owed to, or of the server on this computer when it is in the
    // list (its set-up unfinished), else over a window made for the server the person is about to set up or add.
    const covered = windows.cover(view, owed?.serverId ?? list.localServer()?.id ?? null, () => this.closed(run));
    // That window shows another of the app's pages (Connect agents), now in front: the first run is not shown, and
    // not over either, so it is still owed.
    if (!covered) {
      this.run = undefined;
      windows.uncover(view);
      return;
    }
    run.donor = covered.donor;
  }

  /**
   * Sets Quadit up on this computer in the first run's window. A new install:
   * the tools step is owed from now on, and its workspace loads under the
   * page. One set up before: its workspace loads, and the first run is over
   * once the page has gone.
   */
  private async setUpHere(name: string): Promise<{ ok: true; next: "tools" | "workspace" } | Refused> {
    const run = this.run;
    if (!run) return OVER;
    const done = await this.parts.list.setUpHere(name, run.donor ?? undefined);
    // Done for good whatever happened meanwhile; shown only to the run that asked.
    if (!done.ok) return done;
    if (this.run !== run) return OVER;
    if (done.workspace === null) {
      this.parts.windows.showAfresh(done.serverId, "/");
      return { ok: true, next: "workspace" };
    }
    const pending = { serverId: done.serverId, workspace: done.workspace, person: name.trim() };
    this.parts.settings.change({ pendingFirstRun: pending });
    run.tools = this.toolsFor(pending);
    this.parts.windows.showAfresh(done.serverId, `/${encodeURIComponent(done.workspace)}`);
    return { ok: true, next: "tools" };
  }

  /** Adds a server elsewhere, whose window the first run's becomes, on its sign-in page: the first run is over. */
  private async connectServer(address: string, allowInsecure: boolean): Promise<AddResult> {
    const run = this.run;
    if (!run) return OVER;
    const added = await this.parts.list.add(address, "", allowInsecure, run.donor ?? undefined);
    if (added.ok) this.closed(run);
    return added;
  }

  /**
   * The tools step's end: once what was asked before is done, the samples
   * are asked for and the window goes to them, under the page, which then
   * ends the first run (endFirstRun). A failure is said, and changes nothing.
   */
  private async finish(): Promise<{ ok: true } | Refused> {
    const run = this.run;
    const tools = run?.tools;
    if (!run || !tools) return OVER;
    const done = await tools.step.finish(async (path) => {
      return this.run === run && this.parts.windows.openCoveredPath(tools.step.serverId, path);
    });
    return this.run === run ? done : OVER;
  }

  /** The first run is over (the page went, or its window closed): its page goes, the window under it stays. */
  private end() {
    this.closed(this.run);
  }

  /** Ends `run` when it is still the one shown: the app no longer starts with it, and no tools step is owed. */
  private closed(run: Run | undefined) {
    if (!run || this.run !== run) return;
    this.run = undefined;
    this.parts.windows.uncover(run.view);
    this.parts.settings.change({ setupDone: true, pendingFirstRun: null });
  }

  private toolsFor(pending: PendingFirstRun): Run["tools"] {
    return { step: this.parts.toolsStep(pending.serverId, pending.workspace), person: pending.person };
  }
}

// Each server's window: its own signed-in session, its pages kept to its
// origin, the bridge its pages may use, and the bar that offers the browser
// sign-in when its page is the sign-in page. On macOS it may have no title
// bar (window-frame.ts): the bar then sits under the strip the window's
// buttons are in, which the page underneath is dragged by.
//
// A window lives as long as its server is added: closing it only hides it,
// so its page keeps receiving the live feed and its notifications and badge
// keep coming, the way chat apps behave. Quitting the app really closes it.
//
// The app's own pages that belong to a window are laid over it (cover), in a
// view of their own: the first run (first-run.ts, desktop contract §10) and
// Connect agents (connect-page.ts, §11). The first run happens in one window
// from the first launch to the workspace, before its server is known. With
// no server yet, the window is made for the server about to be added, with
// an id of its own, and loads nothing; the server added with that id (cover
// gives it) takes it, when the window's frame is the one that server's would
// have. Until then nothing in it is a server's page, and its preload gives
// nothing.
//
// The rules every page of a server's window is held to:
//   - its session is the partition "persist:server-<id>", shared with no other server;
//   - Node is off, the renderer is sandboxed, contexts are isolated, web security is on;
//   - a navigation of a window whose server is not known (yet, or any more)
//     is stopped;
//   - a navigation to another origin is stopped and that address goes to the
//     system browser (http and https only); from the sign-in page it starts
//     the browser sign-in instead, since providers refuse embedded windows;
//   - nothing reaches the server's /desktop/ addresses (the sign-in finish)
//     but the app's own hand-off (finishSignIn): not a page's navigation,
//     a redirect, a frame or window.open, and not a link or a notification,
//     which may only open pages of the web app (origins.ts, appPage);
//   - its window loads the server's address only once the server can be
//     reached (whenReachable): the server on this computer only while it
//     runs, since whatever else answers at its address would get its
//     sign-in; until then the window waits, dark, and if the server is not
//     running it shows why, over it; a later load asked meanwhile (a link)
//     replaces an earlier one (pending-loads.ts);
//   - where the app can sign the window in without a form (the server on
//     this computer: signInWithoutForm), it does before a load and when the
//     page lands on the sign-in page, as often as app-sign-in.ts allows;
//     after one from the sign-in page, that page goes on to where it was
//     headed, unless the window has moved on or a newer load waits;
//   - a frame of a page stays on the server's own pages;
//   - window.open of the same origin opens another window held to the same
//     rules; anything else goes to the system browser;
//   - only the server's own pages get the bridge (its preload asks here for
//     its server's origin at each load), and each message on it is checked
//     again here against the frame that sent it; what a page
//     publishes and answers goes to Requests (requests.ts), and goes with
//     the page; its ask to open Connect agents lays that app page over its
//     window, at most once a second (open-connect.ts).

import {
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  Notification,
  type Session,
  session,
  shell,
  type WebContents,
  WebContentsView,
  webContents,
  type WebPreferences,
} from "electron";
import { AppSignIn } from "@/main/app-sign-in";
import { ConnectionErrors } from "@/main/connection-error";
import { giveContextMenu } from "@/main/context-menu";
import { NoticeGate } from "@/main/notices";
import { OpenConnect } from "@/main/open-connect";
import { PendingLoads } from "@/main/pending-loads";
import { HANDOFF_HEADER } from "@/main/handoff";
import { appPage, browserAddress, isHandoffPage, isOwnPage } from "@/main/origins";
import { type Fetch, fitOf } from "@/main/probe";
import type { Requests } from "@/main/requests";
import { newServerId, type Server, type ServerStore } from "@/main/servers";
import { FIRST_RUN_SPEAKS, type Frame, frameFor } from "@/main/window-frame";
import {
  BRIDGE_BADGE,
  BRIDGE_LISTENING,
  BRIDGE_NOTIFY,
  BRIDGE_OPEN_CONNECT,
  BRIDGE_ORIGIN,
  BRIDGE_OUTCOME,
  BRIDGE_PUBLISH,
  badgeOf,
  type DesktopRequest,
  summaryOf,
  VERSION_SWITCH,
} from "@/shared/bridge";

/** The path of the web app's sign-in page: where the bar offering the browser sign-in shows. */
const SIGN_IN_PATH = "/login";
const BAR_HEIGHT = 52;

/** An app page laid over a window (cover), and what to do when the person closes that window. */
interface Cover {
  view: WebContentsView;
  closed: () => void;
}

/** A load of a server's window: the address, the headers it carries, and what to do once it has loaded. */
interface Load {
  url: string;
  extraHeaders?: string;
  then?: () => void;
}

/** What a server's windows need from the rest of the app. */
export interface WindowsSetup {
  version: string;
  /** The bridge preload and the bundled pages' preload, as file paths. */
  bridgePreload: string;
  pagesPreload: string;
  /** The bundled sign-in bar page for a server. */
  signInBarUrl(serverId: string): string;
  /** The bundled page saying a server's page could not be loaded, with what it says. */
  connectionErrorUrl(words: { name: string; origin: string; reason: string }): string;
  /** Starts the browser sign-in for a server. */
  signIn(serverId: string): void;
  /** A page of a server (the web contents `reporter`) reported the unread count of one of its workspaces. */
  reportUnread(serverId: string, reporter: number, workspace: string, count: number): void;
  /** A page went away: what it reported no longer counts. */
  forgetUnread(reporter: number): void;
  /** Where the pages' summaries and their answers to requests go. */
  requests: Requests;
  /** A window was shown, hidden or focused: the menus that list them change. */
  changed(): void;
  /**
   * Whether a server's address may be loaded, once that is known: at once
   * for a server elsewhere; for the one the app runs on this computer, once
   * it has started (ok) or failed to (not, and why).
   */
  whenReachable(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Signs a server's window in without a form where the app can (the
   * server on this computer, through its app key) and the window's session,
   * reached through `fetch`, has none; true when it did just now.
   */
  signInWithoutForm(serverId: string, fetch: Fetch): Promise<boolean>;
  /** Whether a server's window, its session reached through `fetch`, is signed in, where the app can ask (as for signInWithoutForm). */
  isSignedIn(serverId: string, fetch: Fetch): Promise<boolean>;
  /** Lays Connect agents over a server's window: its page asked (open-connect.ts). */
  openConnect(serverId: string): void;
}

export class ServerWindows {
  private windows = new Map<string, BrowserWindow>();
  /** Which server each web contents belongs to: the windows and the windows their pages opened. */
  private owners = new Map<number, string>();
  private bars = new Map<string, WebContentsView>();
  /** The height of the strip at the top of each window without a title bar (window-frame.ts); absent with one. */
  private strips = new WeakMap<BrowserWindow, number>();
  /** Servers whose sign-in bar the person closed; it stays away until the app restarts. */
  private barDismissed = new Set<string>();
  /** Shown notifications, held so their click still arrives (macOS forgets the handlers of collected ones). */
  private notifications = new Map<string, Notification>();
  private gate = new NoticeGate();
  private errors: ConnectionErrors;
  private sessions = new WeakSet<Session>();
  private loads: PendingLoads<string, Load, { ok: true } | { ok: false; reason: string }>;
  private appSignIn: AppSignIn;
  private quitting = false;
  /** The window made for the server about to be added (cover), and the id that server is to have. */
  private waiting: { id: string; win: BrowserWindow } | undefined;
  /** The app's own page laid over each window that has one (cover). */
  private covers = new Map<BrowserWindow, Cover>();

  constructor(
    private store: ServerStore,
    private setup: WindowsSetup,
  ) {
    ipcMain.on(BRIDGE_NOTIFY, (event, raw: unknown) => {
      const server = this.bridgeSender(event);
      if (server) this.notify(server, event.sender.id, raw);
    });
    ipcMain.on(BRIDGE_PUBLISH, (event, raw: unknown) => {
      const server = this.bridgeSender(event);
      const summary = raw === null ? null : summaryOf(raw);
      if (server && (raw === null || summary)) setup.requests.publish(event.sender.id, server.id, summary);
    });
    ipcMain.on(BRIDGE_LISTENING, (event, raw: unknown) => {
      const server = this.bridgeSender(event);
      if (server) setup.requests.listen(event.sender.id, server.id, raw === true);
    });
    ipcMain.on(BRIDGE_OUTCOME, (event, raw: unknown) => {
      if (this.bridgeSender(event)) setup.requests.answer(event.sender.id, raw);
    });
    // Asked by the preload at every page load, synchronously: the origin whose pages get the bridge in this window.
    ipcMain.on(BRIDGE_ORIGIN, (event) => {
      const serverId = this.owners.get(event.sender.id);
      event.returnValue = (serverId && this.store.get(serverId)?.origin) || "";
    });
    const connectAsks = new OpenConnect((serverId) => setup.openConnect(serverId));
    ipcMain.on(BRIDGE_OPEN_CONNECT, (event) => connectAsks.asked(this.bridgeSender(event)?.id ?? null));
    this.appSignIn = new AppSignIn({
      signIn: (serverId) => setup.signInWithoutForm(serverId, this.fetcher(serverId)),
      isSignedIn: (serverId) => setup.isSignedIn(serverId, this.fetcher(serverId)),
    });
    this.loads = new PendingLoads(
      async (serverId) => {
        const reach = await setup.whenReachable(serverId);
        // Signed in before the page loads, so that it does not show the sign-in page first.
        if (reach.ok) await this.appSignIn.attempt(serverId);
        return reach;
      },
      (serverId, load, reach) => this.arrive(serverId, load, reach),
    );
    this.errors = new ConnectionErrors({
      pagesPreload: setup.pagesPreload,
      pageUrl: (words) => setup.connectionErrorUrl(words),
    });
    // A server's answer changed (its hand-off at start, say): the sign-in bar may come or go.
    store.onChange(() => {
      for (const [serverId, win] of this.windows) this.placeBar(win, serverId);
    });
    ipcMain.on(BRIDGE_BADGE, (event, raw: unknown) => {
      const server = this.bridgeSender(event);
      const badge = badgeOf(raw);
      if (server && badge) setup.reportUnread(server.id, event.sender.id, badge.workspace, badge.count);
    });
  }

  /**
   * Makes a window for every server, shown for those that were open when the
   * app last stopped unless `show` is false (they stay marked open for the
   * next start); gives whether any is shown.
   */
  restore({ show }: { show: boolean }): boolean {
    for (const server of this.store.list()) this.ensure(server, server.origin + "/", show && server.open);
    return show && this.store.list().some((server) => server.open);
  }

  /** Shows and focuses a server's window, at `path` when given and a page of the web app. */
  show(serverId: string, path?: string) {
    const server = this.store.get(serverId);
    if (!server) return;
    const target = appPage(server.origin, path ?? "/") ?? server.origin + "/";
    const known = this.windows.get(serverId);
    const win = known ?? this.ensure(server, target, true);
    if (known && path !== undefined) this.goTo(win.webContents, server, target);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Navigates the workspace that answered the tools step, while it is still under the cover. */
  async openCoveredPath(serverId: string, path: string): Promise<boolean> {
    const win = this.windows.get(serverId);
    const server = this.store.get(serverId);
    if (!win || !this.covers.has(win) || !server) return false;
    const target = appPage(server.origin, path);
    if (!target || !isOwnPage(win.webContents.getURL(), server.origin) || win.webContents.isLoadingMainFrame())
      return false;
    return this.pushPath(win.webContents, target).then(
      (url) => url === target,
      () => false,
    );
  }

  /**
   * Shows the server's window loading `path`, a page of the web app, anew,
   * never by moving the page that is there: after the app changed the
   * window's session, the page must start over to see it.
   */
  showAfresh(serverId: string, path: string) {
    const server = this.store.get(serverId);
    if (!server) return;
    const target = appPage(server.origin, path) ?? server.origin + "/";
    if (this.windows.has(serverId)) this.load(serverId, { url: target });
    else this.ensure(server, target, true);
    this.show(serverId);
  }

  /**
   * The network as a server's window has it: its own session, whose cookies
   * the requests carry and whose jar the answers' cookies land in.
   */
  fetcher(serverId: string): Fetch {
    const own = session.fromPartition(partitionOf(serverId));
    return (url, init) => own.fetch(url, init);
  }

  /**
   * The last step of the hand-off: loads the server's sign-in finish
   * (`finishUrl`, made by SignInFlows.redeem for a flow this app started) in
   * its window, shown. The only way the app ever loads a /desktop/ address,
   * and the only load that carries the hand-off header the server asks for.
   */
  finishSignIn(serverId: string, finishUrl: string, next?: string) {
    const server = this.store.get(serverId);
    if (!server || !isHandoffPage(finishUrl, server.origin)) return;
    this.show(serverId);
    this.load(serverId, {
      url: finishUrl,
      extraHeaders: `${HANDOFF_HEADER}: 1\n`,
      then: () => {
        // Signed in: on to the page the window was on its way to.
        const target = next && appPage(server.origin, next);
        const window = this.windows.get(serverId);
        if (target && window) this.goTo(window.webContents, server, target);
      },
    });
  }

  /**
   * The page of the web app a server's window is on its way to: where its
   * sign-in page will send it once signed in (/login?next=…), when it is there.
   */
  waitingFor(serverId: string): string | undefined {
    const server = this.store.get(serverId);
    const contents = this.windows.get(serverId)?.webContents;
    const url = contents && URL.parse(contents.getURL());
    if (!server || !url || url.origin !== server.origin || url.pathname !== SIGN_IN_PATH) return undefined;
    const next = url.searchParams.get("next");
    return next && appPage(server.origin, next) ? next : undefined;
  }

  /** The server whose window is in front, if one is. */
  focused(): Server | undefined {
    const contents = BrowserWindow.getFocusedWindow()?.webContents;
    const id = contents && this.owners.get(contents.id);
    return id ? this.store.get(id) : undefined;
  }

  /** Whether a window of the server is in front of the person: focused, shown and not minimized. */
  private inFront(serverId: string): boolean {
    const win = BrowserWindow.getFocusedWindow();
    return !!win && win.isVisible() && !win.isMinimized() && this.owners.get(win.webContents.id) === serverId;
  }

  /** Whether a server's window is shown now. */
  isShown(serverId: string): boolean {
    return this.windows.get(serverId)?.isVisible() ?? false;
  }

  /** The web contents id of a server's window's own page (what it publishes is known by it: requests.ts); undefined without a window. */
  pageOf(serverId: string): number | undefined {
    return this.windows.get(serverId)?.webContents.id;
  }

  /**
   * Lays `view` (an app page) over the whole of a window, shown and in front,
   * and keeps it there, sized with the window, until uncover: over the window
   * of the server `serverId`, made when it has none, or, with null, over a
   * window made for the server about to be added. Gives the id a server added
   * now is to have to take the window covered (`donor`): the one made for
   * it; null over an existing server's window, whose id stays that server's.
   * Laid again, the view's window comes to the front and the same is given.
   * A window holds one cover: over one another view covers, or for a server
   * that is not added, nothing is laid, that window (if any) comes to the
   * front with its cover, and the answer is undefined. Closing the window
   * calls `closed` (the cover's page is over); a window still waiting for
   * its server then goes.
   */
  cover(view: WebContentsView, serverId: string | null, closed: () => void): { donor: string | null } | undefined {
    const laid = this.coverOf(view);
    if (laid) {
      this.toFront(laid);
      return { donor: this.waiting?.win === laid ? this.waiting.id : null };
    }
    const server = serverId ? this.store.get(serverId) : undefined;
    if (serverId && !server) return undefined;
    let win: BrowserWindow;
    let donor: string | null = null;
    if (server) win = this.ensure(server, server.origin + "/", true);
    else {
      donor = newServerId();
      win = this.make(donor, "Quadit", frameFor(process.platform, FIRST_RUN_SPEAKS), true);
      this.waiting = { id: donor, win };
    }
    if (this.covers.has(win)) {
      this.toFront(win);
      return undefined;
    }
    this.covers.set(win, { view, closed });
    win.contentView.addChildView(view);
    this.placeCover(win);
    this.toFront(win);
    view.webContents.focus();
    return { donor };
  }

  /** Reserves the id for a probed remote. A different frame needs its own native window name during the swap. */
  idForWelcomeServer(id: string | undefined, speaks: Pick<Server, "inset">): string | undefined {
    const waiting = this.waiting;
    if (!waiting || waiting.id !== id) return undefined;
    if ((this.strips.get(waiting.win) ?? 0) !== frameFor(process.platform, speaks).strip) waiting.id = newServerId();
    return waiting.id;
  }

  /**
   * Takes the cover `view` away, showing the page under it with the keys
   * back on it, and closes the view; a window still waiting for its server
   * goes with it.
   */
  uncover(view: WebContentsView) {
    const win = this.coverOf(view);
    if (win) {
      this.covers.delete(win);
      if (!win.isDestroyed()) {
        win.contentView.removeChildView(view);
        win.webContents.focus();
      }
      if (this.waiting?.win === win) {
        this.waiting = undefined;
        win.destroy();
      }
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** The window `view` covers, if it covers one. */
  private coverOf(view: WebContentsView): BrowserWindow | undefined {
    for (const [win, cover] of this.covers) if (cover.view === view) return win;
    return undefined;
  }

  private toFront(win: BrowserWindow) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Closes a removed server's window and forgets what it kept: cookies, storage, its place on screen. */
  async forget(server: Server) {
    const win = this.windows.get(server.id);
    // The page over it is over, as when the person closes the window.
    if (win) this.covers.get(win)?.closed();
    this.windows.delete(server.id);
    this.bars.delete(server.id);
    this.gate.forget(server.id);
    win?.destroy();
    BrowserWindow.clearPersistedState(windowName(server.id));
    await session.fromPartition(partitionOf(server.id)).clearStorageData();
  }

  /** From now on closing a window closes it, so the app can quit. */
  quit() {
    this.quitting = true;
  }

  /**
   * The computer woke: a window whose page could not be loaded tries again,
   * and every loaded page is told the network may be back ("online"), which
   * the web app answers by making sure its live stream is (web/src/data/sync.ts).
   */
  wake() {
    this.errors.retryAll();
    for (const contents of webContents.getAllWebContents()) {
      const serverId = this.owners.get(contents.id);
      const server = serverId && this.store.get(serverId);
      if (server && isOwnPage(contents.getURL(), server.origin)) {
        void contents.executeJavaScript('dispatchEvent(new Event("online"))').catch(() => {});
      }
    }
  }

  /**
   * The server has just started (again): its window, when its page could
   * not be loaded, tries again now, and the app may sign it in again.
   */
  serverStarted(serverId: string) {
    this.appSignIn.serverStarted(serverId);
    const win = this.windows.get(serverId);
    if (win) this.errors.retry(win);
  }

  /** Tries again the window a connection error page sits over (its Try again). */
  retryFrom(contents: WebContents) {
    this.errors.retryFrom(contents);
  }

  /** Hides the sign-in bar a bundled page sits in (the bar's own close button). */
  dismissBar(contents: WebContents) {
    for (const [serverId, bar] of this.bars) {
      if (bar.webContents !== contents) continue;
      this.barDismissed.add(serverId);
      const win = this.windows.get(serverId);
      if (win) this.placeBar(win, serverId);
    }
  }

  /**
   * The server's window, made when it has none, loading `firstUrl`: the window
   * made for it before it was known (cover) when it has the frame this
   * server's would have. Otherwise a new one; when it is that window's
   * server, the new one is made hidden where that window is and takes its
   * place, with what covers it, at once: never two windows on screen.
   */
  private ensure(server: Server, firstUrl: string, shown: boolean): BrowserWindow {
    const known = this.windows.get(server.id);
    if (known) return known;
    const frame = frameFor(process.platform, server);
    const waiting = this.waiting?.id === server.id && !this.waiting.win.isDestroyed() ? this.waiting.win : undefined;
    let win: BrowserWindow;
    if (waiting && (this.strips.get(waiting) ?? 0) === frame.strip) {
      this.waiting = undefined;
      win = waiting;
      win.setTitle(server.name);
      if (shown) win.show();
    } else if (waiting) win = this.replaceWaiting(waiting, server, frame);
    else win = this.make(server.id, server.name, frame, shown);
    this.windows.set(server.id, win);
    if (shown) this.store.change(server.id, { open: true });
    this.load(server.id, { url: firstUrl });
    return win;
  }

  /** Prepares the framed window behind Welcome, then transfers the cover and reveals it at the same bounds. */
  private replaceWaiting(waiting: BrowserWindow, server: Server, frame: Frame): BrowserWindow {
    const bounds = waiting.getBounds();
    const oldId = this.owners.get(waiting.webContents.id);
    // A remote was probed before its id was reserved. A local install was saved before its probe and might
    // already own this name: then Electron needs the old window destroyed before it will make the new one.
    const prepared = oldId === server.id ? undefined : this.make(server.id, server.name, frame, false);
    prepared?.setBounds(bounds);
    const cover = this.covers.get(waiting);
    if (cover) {
      waiting.contentView.removeChildView(cover.view);
      this.covers.delete(waiting);
    }
    this.waiting = undefined;
    waiting.destroy();

    const win = prepared ?? this.make(server.id, server.name, frame, false);
    if (!prepared) win.setBounds(bounds);
    if (oldId && oldId !== server.id) BrowserWindow.clearPersistedState(windowName(oldId));
    if (cover) {
      win.contentView.addChildView(cover.view);
      this.covers.set(win, cover);
      this.placeCover(win);
    }
    win.show();
    return win;
  }

  /** A window for the server with the id `serverId` (added, or about to be), held to the rules at the top of this file. */
  private make(serverId: string, title: string, frame: Frame, shown: boolean): BrowserWindow {
    this.prepareSession(serverId);
    const win = new BrowserWindow({
      name: windowName(serverId),
      windowStatePersistence: true,
      width: 1280,
      height: 860,
      minWidth: 480,
      minHeight: 400,
      title,
      // The web app's dark --bg (its default theme), so the window is not white until its page paints.
      backgroundColor: "#131419",
      show: shown,
      ...frame.options,
      webPreferences: this.preferencesFor(serverId),
    });
    if (frame.strip) this.strips.set(win, frame.strip);
    this.guard(win.webContents, serverId);
    this.errors.watch(
      win,
      () => this.store.get(serverId),
      (url) => this.load(serverId, { url }),
    );

    win.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      // The page over it is over: its owner takes it away (uncover), and with it a window no server took.
      this.covers.get(win)?.closed();
      if (win.isDestroyed()) return;
      if (this.waiting?.win === win) {
        this.waiting = undefined;
        win.destroy();
      } else win.hide();
    });
    win.on("show", () => {
      this.store.change(serverId, { open: true });
      this.setup.changed();
    });
    win.on("hide", () => {
      this.store.change(serverId, { open: false });
      this.setup.changed();
    });
    win.on("focus", () => {
      // The keys go to the page over the window, while there is one.
      this.covers.get(win)?.view.webContents.focus();
      this.setup.changed();
    });
    win.on("resize", () => {
      this.placeBar(win, serverId);
      this.placeCover(win);
    });
    win.on("closed", () => {
      this.covers.delete(win);
      if (this.windows.get(serverId) !== win) return;
      this.windows.delete(serverId);
      this.loads.forget(serverId);
    });
    return win;
  }

  /** The cover fills the window it is over. */
  private placeCover(win: BrowserWindow) {
    const cover = this.covers.get(win);
    if (!cover || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    cover.view.setBounds({ x: 0, y: 0, width, height });
  }

  /** Loads an address in a server's window once the server can be reached; a newer load asked meanwhile wins. */
  private load(serverId: string, load: Load) {
    this.loads.ask(serverId, load);
  }

  /** A load whose wait is over: loaded when the server can be reached, and otherwise the reason shown over the window. */
  private arrive(serverId: string, load: Load, reach: { ok: true } | { ok: false; reason: string }) {
    const win = this.windows.get(serverId);
    const server = this.store.get(serverId);
    if (!win || win.isDestroyed() || !server) return;
    if (!reach.ok) {
      this.errors.show(win, load.url, { name: server.name, origin: server.origin, reason: reach.reason });
      return;
    }
    void win.webContents
      .loadURL(load.url, load.extraHeaders ? { extraHeaders: load.extraHeaders } : undefined)
      .then(() => {
        if (!win.isDestroyed()) load.then?.();
      })
      .catch(() => {}); // A load that failed shows the connection error (connection-error.ts watches for it).
  }

  /** The partition's user agent and permissions, set once per session. */
  private prepareSession(serverId: string) {
    const own = session.fromPartition(partitionOf(serverId));
    if (this.sessions.has(own)) return;
    this.sessions.add(own);
    own.setUserAgent(`${own.getUserAgent()} QuaditDesktop/${this.setup.version}`);
    // What a task tracker needs and nothing else: copying, full-screen video, notifications.
    // Never clipboard-read: a script reading the clipboard whenever it likes
    // would see passwords and tokens copied anywhere. Pasting needs no
    // permission: the Edit menu's Paste and its key hand the page what the
    // person chose to paste, as a paste event.
    const allowed = new Set(["clipboard-sanitized-write", "fullscreen", "notifications"]);
    own.setPermissionRequestHandler((contents, permission, decide, details) => {
      const current = this.store.get(serverId);
      decide(
        !!current && allowed.has(permission) && isOwnPage(details.requestingUrl ?? contents.getURL(), current.origin),
      );
    });
    own.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      const current = this.store.get(serverId);
      return !!current && allowed.has(permission) && requestingOrigin === current.origin;
    });
  }

  private preferencesFor(serverId: string): WebPreferences {
    return {
      partition: partitionOf(serverId),
      preload: this.setup.bridgePreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [VERSION_SWITCH + this.setup.version],
    };
  }

  /** Holds a server's web contents (its window, or one its page opened) to the rules at the top of this file. */
  private guard(contents: WebContents, serverId: string) {
    this.owners.set(contents.id, serverId);
    const reporter = contents.id;
    contents.once("destroyed", () => {
      this.owners.delete(reporter);
      this.setup.forgetUnread(reporter);
      this.setup.requests.forget(reporter);
    });
    giveContextMenu(contents);

    const stopIfAway = (event: { preventDefault(): void }, url: string) => {
      const server = this.store.get(serverId);
      if (!server) return event.preventDefault();
      // Only finishSignIn loads the hand-off's pages, and it is no navigation of the page's.
      if (isHandoffPage(url, server.origin)) return event.preventDefault();
      if (isOwnPage(url, server.origin)) return;
      event.preventDefault();
      this.leave(contents, server, url);
    };
    contents.on("will-navigate", (event) => stopIfAway(event, event.url));
    contents.on("will-redirect", (event) => stopIfAway(event, event.url));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // A frame of the page: kept to the server's own pages (and the empty ones a page makes itself).
    // It hands nothing to the system browser: a frame navigating is no person's click.
    contents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) return;
      const server = this.store.get(serverId);
      const { url } = event;
      const own = !!server && isOwnPage(url, server.origin) && !isHandoffPage(url, server.origin);
      if (!own && url !== "about:blank" && url !== "about:srcdoc") event.preventDefault();
    });

    contents.setWindowOpenHandler(({ url }) => {
      const server = this.store.get(serverId);
      if (server && isOwnPage(url, server.origin) && !isHandoffPage(url, server.origin)) {
        return { action: "allow", overrideBrowserWindowOptions: { webPreferences: this.preferencesFor(server.id) } };
      }
      if (server && !isHandoffPage(url, server.origin)) this.leave(contents, server, url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (child) => this.guard(child.webContents, serverId));

    const pageChanged = () => {
      const win = this.windows.get(serverId);
      const server = this.store.get(serverId);
      if (!win || win.webContents !== contents || !server) return;
      this.placeBar(win, serverId);
      const signInPage = onSignInPage(contents, server);
      this.appSignIn.navigated(serverId, signInPage);
      // Landed on the sign-in page: signed in without the form where the app can, and on to where this page is
      // headed, when it is still the page shown (app-sign-in.ts says when) and no load of the app's waits.
      if (!signInPage) return;
      const target = appPage(server.origin, this.waitingFor(serverId) ?? "/");
      void this.appSignIn.fromSignInPage(serverId).then((goOn) => {
        if (!goOn || !target || contents.isDestroyed() || !onSignInPage(contents, server)) return;
        if (!this.loads.waiting(serverId)) this.load(serverId, { url: target });
      });
    };
    contents.on("did-start-navigation", (details) => {
      const win = this.windows.get(serverId);
      if (win?.webContents === contents && details.isMainFrame && !details.isSameDocument)
        this.appSignIn.navigationStarted(serverId);
    });
    contents.on("did-navigate", () => {
      // A new page: what the last one reported and published goes with it, and this one reports anew.
      this.setup.forgetUnread(reporter);
      this.setup.requests.forget(reporter);
      pageChanged();
    });
    contents.on("did-navigate-in-page", pageChanged);
  }

  /** A page of the server tried to go to `url`, outside the server. */
  private leave(contents: WebContents, server: Server, url: string) {
    if (onSignInPage(contents, server) && handoffWorks(server)) {
      this.setup.signIn(server.id);
      return;
    }
    const address = browserAddress(url);
    if (address) void shell.openExternal(address);
  }

  /** Moves a server's page to `url` (on its origin), keeping the page when it is already the web app. */
  private goTo(contents: WebContents, server: Server, url: string) {
    if (!isOwnPage(contents.getURL(), server.origin) || contents.isLoading()) {
      this.load(server.id, { url });
      return;
    }
    void this.pushPath(contents, url);
  }

  private pushPath(contents: WebContents, url: string): Promise<string> {
    // The web app routes with the History API: pushing the path and telling
    // its router keeps the page (and anything typed in it) instead of reloading.
    const { pathname, search, hash } = new URL(url);
    const path = JSON.stringify(pathname + search + hash);
    return contents.executeJavaScript(
      `history.pushState(null, "", ${path}); dispatchEvent(new PopStateEvent("popstate")); location.href;`,
    );
  }

  /** The server a bridge message came from, or undefined when its sender is not that server's own page. */
  private bridgeSender(event: IpcMainEvent): Server | undefined {
    const serverId = this.owners.get(event.sender.id);
    const server = serverId ? this.store.get(serverId) : undefined;
    const frame = event.senderFrame;
    if (!server || !frame || frame !== event.sender.mainFrame) return undefined;
    return isOwnPage(frame.url, server.origin) ? server : undefined;
  }

  /**
   * Shows what a server's page (the web contents `page`) sent as a native
   * notification, when the gate lets it through (notices.ts) and the person
   * is not looking at that server's window already, where the web app shows
   * it. On macOS its buttons and reply field are shown too: what the person
   * does there goes back to that page alone, and when the page cannot do it,
   * the window opens at the notification's path instead.
   */
  private notify(server: Server, page: number, raw: unknown) {
    const n = this.gate.admit(server.id, raw, Date.now());
    if (!n || !Notification.isSupported() || this.inFront(server.id)) return;
    const key = n.tag ? `${server.id}:${n.tag}` : `${server.id}:${Date.now()}:${Math.random()}`;
    this.notifications.get(key)?.close();
    const mac = process.platform === "darwin";
    const actions = mac ? (n.actions ?? []) : [];
    const reply = mac ? n.reply : undefined;
    const note = new Notification({
      title: n.title,
      body: n.body,
      actions: actions.map((action) => ({ type: "button", text: action.label })),
      ...(reply ? { hasReply: true, replyPlaceholder: reply.placeholder } : {}),
    });
    const path = appPage(server.origin, n.path) ? n.path : "/";
    const carryOut = (request: DesktopRequest) => {
      this.notifications.delete(key);
      void this.setup.requests.toPage(page, server.id, request).then((outcome) => {
        if (!outcome.ok) this.show(server.id, outcome.path ?? path);
      });
    };
    note.on("click", () => {
      this.notifications.delete(key);
      this.show(server.id, path);
    });
    note.on("action", ({ actionIndex }) => {
      const action = actions[actionIndex];
      if (action) carryOut({ kind: "action", request: action.request });
    });
    note.on("reply", ({ reply: text }) => {
      if (reply) carryOut({ kind: "action", request: reply.request, text });
    });
    note.on("close", () => {
      if (this.notifications.get(key) === note) this.notifications.delete(key);
    });
    this.notifications.set(key, note);
    note.show();
  }

  /**
   * Shows the sign-in bar over the top of a server's window when its page is the sign-in page, and hides it otherwise.
   * In a window without a title bar it sits under the strip, which stays the page's to drag the window by.
   */
  private placeBar(win: BrowserWindow, serverId: string) {
    const server = this.store.get(serverId);
    const wanted =
      !!server && !this.barDismissed.has(serverId) && handoffWorks(server) && onSignInPage(win.webContents, server);
    let bar = this.bars.get(serverId);
    if (!wanted) {
      if (bar) bar.setVisible(false);
      return;
    }
    if (!bar) {
      bar = new WebContentsView({
        webPreferences: {
          preload: this.setup.pagesPreload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      bar.webContents.on("will-navigate", (event) => event.preventDefault());
      bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      void bar.webContents.loadURL(this.setup.signInBarUrl(serverId));
      win.contentView.addChildView(bar);
      this.bars.set(serverId, bar);
    }
    const { width } = win.getContentBounds();
    bar.setBounds({ x: 0, y: this.strips.get(win) ?? 0, width, height: BAR_HEIGHT });
    bar.setVisible(true);
  }
}

export function partitionOf(serverId: string): string {
  return `persist:server-${serverId}`;
}

function windowName(serverId: string): string {
  return `server-${serverId}`;
}

function onSignInPage(contents: WebContents, server: Server): boolean {
  const url = URL.parse(contents.getURL());
  return !!url && url.origin === server.origin && url.pathname === SIGN_IN_PATH;
}

/** Whether the server speaks the hand-off this app knows. */
function handoffWorks(server: Server): boolean {
  return fitOf(server.handoff) === "ok";
}

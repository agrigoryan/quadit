// Each server's window: its own signed-in session, its pages kept to its
// origin, the bridge its pages may use, and the bar that offers the browser
// sign-in when its page is the sign-in page.
//
// A window lives as long as its server is added: closing it only hides it,
// so its page keeps receiving the live feed and its notifications and badge
// keep coming, the way chat apps behave. Quitting the app really closes it.
//
// The rules every page of a server's window is held to:
//   - its session is the partition "persist:server-<id>", shared with no other server;
//   - Node is off, the renderer is sandboxed, contexts are isolated, web security is on;
//   - a navigation to another origin is stopped and that address goes to the
//     system browser (http and https only); from the sign-in page it starts
//     the browser sign-in instead, since providers refuse embedded windows;
//   - nothing reaches the server's /desktop/ addresses (the sign-in finish)
//     but the app's own hand-off (finishSignIn): not a page's navigation,
//     a redirect, a frame or window.open, and not a link or a notification,
//     which may only open pages of the web app (origins.ts, appPage);
//   - a frame of a page stays on the server's own pages;
//   - window.open of the same origin opens another window held to the same
//     rules; anything else goes to the system browser;
//   - only the server's own pages get the bridge, and each message on it is
//     checked again here against the frame that sent it.

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
import { ConnectionErrors } from "@/main/connection-error";
import { giveContextMenu } from "@/main/context-menu";
import { NoticeGate } from "@/main/notices";
import { HANDOFF_HEADER } from "@/main/handoff";
import { appPage, browserAddress, isHandoffPage, isOwnPage } from "@/main/origins";
import { fitOf } from "@/main/probe";
import type { Server, ServerStore } from "@/main/servers";
import { BRIDGE_BADGE, BRIDGE_NOTIFY, ORIGIN_SWITCH, VERSION_SWITCH } from "@/shared/bridge";

/** The path of the web app's sign-in page: where the bar offering the browser sign-in shows. */
const SIGN_IN_PATH = "/login";
const BAR_HEIGHT = 52;

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
  /** A window was shown, hidden or focused: the menus that list them change. */
  changed(): void;
}

export class ServerWindows {
  private windows = new Map<string, BrowserWindow>();
  /** Which server each web contents belongs to: the windows and the windows their pages opened. */
  private owners = new Map<number, string>();
  private bars = new Map<string, WebContentsView>();
  /** Servers whose sign-in bar the person closed; it stays away until the app restarts. */
  private barDismissed = new Set<string>();
  /** Shown notifications, held so their click still arrives (macOS forgets the handlers of collected ones). */
  private notifications = new Map<string, Notification>();
  private gate = new NoticeGate();
  private errors: ConnectionErrors;
  private sessions = new WeakSet<Session>();
  private quitting = false;

  constructor(
    private store: ServerStore,
    private setup: WindowsSetup,
  ) {
    ipcMain.on(BRIDGE_NOTIFY, (event, raw: unknown) => {
      const server = this.bridgeSender(event);
      if (server) this.notify(server, raw);
    });
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
      const { count, workspace } = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      if (!server || typeof count !== "number" || !Number.isFinite(count)) return;
      if (typeof workspace !== "string" || workspace.length > 200) return;
      setup.reportUnread(server.id, event.sender.id, workspace, Math.min(Math.max(Math.floor(count), 0), 99_999));
    });
  }

  /** Makes a window for every server, shown for those that were open when the app last stopped; gives whether any is shown. */
  restore(): boolean {
    for (const server of this.store.list()) this.ensure(server, server.origin + "/", server.open);
    return this.store.list().some((server) => server.open);
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
    const window = this.windows.get(serverId);
    if (!window) return;
    void window.webContents
      .loadURL(finishUrl, { extraHeaders: `${HANDOFF_HEADER}: 1\n` })
      .then(() => {
        // Signed in: on to the page the window was on its way to.
        const target = next && appPage(server.origin, next);
        if (target && !window.isDestroyed()) this.goTo(window.webContents, server, target);
      })
      .catch(() => {}); // A finish that did not load leaves the window where it failed, and the person starts again.
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

  /** Closes a removed server's window and forgets what it kept: cookies, storage, its place on screen. */
  async forget(server: Server) {
    const win = this.windows.get(server.id);
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

  private ensure(server: Server, firstUrl: string, shown: boolean): BrowserWindow {
    const known = this.windows.get(server.id);
    if (known) return known;
    this.prepareSession(server);
    const win = new BrowserWindow({
      name: windowName(server.id),
      windowStatePersistence: true,
      width: 1280,
      height: 860,
      minWidth: 480,
      minHeight: 400,
      title: server.name,
      show: shown,
      webPreferences: this.preferencesFor(server),
    });
    this.windows.set(server.id, win);
    this.guard(win.webContents, server.id);
    this.errors.watch(win, () => this.store.get(server.id));
    if (shown) this.store.change(server.id, { open: true });

    win.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
    });
    win.on("show", () => {
      this.store.change(server.id, { open: true });
      this.setup.changed();
    });
    win.on("hide", () => {
      this.store.change(server.id, { open: false });
      this.setup.changed();
    });
    win.on("focus", () => this.setup.changed());
    win.on("resize", () => this.placeBar(win, server.id));
    win.on("closed", () => {
      if (this.windows.get(server.id) === win) this.windows.delete(server.id);
    });
    void win.webContents.loadURL(firstUrl);
    return win;
  }

  /** The partition's user agent and permissions, set once per session. */
  private prepareSession(server: Server) {
    const own = session.fromPartition(partitionOf(server.id));
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
      const current = this.store.get(server.id);
      decide(
        !!current && allowed.has(permission) && isOwnPage(details.requestingUrl ?? contents.getURL(), current.origin),
      );
    });
    own.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      const current = this.store.get(server.id);
      return !!current && allowed.has(permission) && requestingOrigin === current.origin;
    });
  }

  private preferencesFor(server: Server): WebPreferences {
    return {
      partition: partitionOf(server.id),
      preload: this.setup.bridgePreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [ORIGIN_SWITCH + server.origin, VERSION_SWITCH + this.setup.version],
    };
  }

  /** Holds a server's web contents (its window, or one its page opened) to the rules at the top of this file. */
  private guard(contents: WebContents, serverId: string) {
    this.owners.set(contents.id, serverId);
    const reporter = contents.id;
    contents.once("destroyed", () => {
      this.owners.delete(reporter);
      this.setup.forgetUnread(reporter);
    });
    giveContextMenu(contents);

    const stopIfAway = (event: { preventDefault(): void }, url: string) => {
      const server = this.store.get(serverId);
      if (!server) return;
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
        return { action: "allow", overrideBrowserWindowOptions: { webPreferences: this.preferencesFor(server) } };
      }
      if (server && !isHandoffPage(url, server.origin)) this.leave(contents, server, url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (child) => this.guard(child.webContents, serverId));

    const pageChanged = () => {
      const win = this.windows.get(serverId);
      if (win?.webContents === contents) this.placeBar(win, serverId);
    };
    contents.on("did-navigate", () => {
      // A new page: what the last one reported goes with it, and this one reports anew.
      this.setup.forgetUnread(reporter);
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
      void contents.loadURL(url);
      return;
    }
    // The web app routes with the History API: pushing the path and telling
    // its router keeps the page (and anything typed in it) instead of reloading.
    const { pathname, search, hash } = new URL(url);
    const path = JSON.stringify(pathname + search + hash);
    void contents.executeJavaScript(
      `history.pushState(null, "", ${path}); dispatchEvent(new PopStateEvent("popstate"));`,
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
   * Shows what a server's page sent as a native notification, when the gate
   * lets it through (notices.ts) and the person is not looking at that
   * server's window already, where the web app shows it.
   */
  private notify(server: Server, raw: unknown) {
    const n = this.gate.admit(server.id, raw, Date.now());
    if (!n || !Notification.isSupported() || this.inFront(server.id)) return;
    const key = n.tag ? `${server.id}:${n.tag}` : `${server.id}:${Date.now()}:${Math.random()}`;
    this.notifications.get(key)?.close();
    const note = new Notification({ title: n.title, body: n.body });
    const path = appPage(server.origin, n.path) ? n.path : "/";
    note.on("click", () => {
      this.notifications.delete(key);
      this.show(server.id, path);
    });
    note.on("close", () => {
      if (this.notifications.get(key) === note) this.notifications.delete(key);
    });
    this.notifications.set(key, note);
    note.show();
  }

  /** Shows the sign-in bar over the top of a server's window when its page is the sign-in page, and hides it otherwise. */
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
    bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
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

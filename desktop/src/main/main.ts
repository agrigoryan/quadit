// The app's start: no switches that open it to other programs
// (switches.ts), one running copy, the quadit:// scheme, and the parts
// put together: the servers (servers.ts), their windows
// (server-windows.ts), what the windows' pages publish and are asked
// (requests.ts), the first run (first-run.ts), the app's own pages
// (app-pages.ts: the server list, setup, Connect agents, the menu-bar panel,
// quick capture), the browser sign-in
// (handoff.ts), the unread badge (unread.ts), the menu (menu.ts), the
// update notice (updates.ts) and the server on this computer
// (local-server.ts), which runs while the app does. Started with
// --background (launch.ts), by the quadit command finding that server not
// running, it opens no window, as at login.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  powerMonitor,
  shell,
  type WebContents,
  webContents,
} from "electron";
import { accountName } from "@/main/account-name";
import { AppPages } from "@/main/app-pages";
import { Capture } from "@/main/capture";
import { ConnectPage } from "@/main/connect-page";
import { FirstConnect } from "@/main/first-connect";
import { FirstRun } from "@/main/first-run";
import { Connections } from "@/main/connections";
import { LocalServer, loopbackPorts } from "@/main/local-server";
import { deepLinkInArgs, parseDeepLink, SCHEME } from "@/main/deep-link";
import { SignInFlows } from "@/main/handoff";
import { ActivateAfterStart, coldStart, Quiet, secondStart } from "@/main/launch";
import { QuitGuard } from "@/main/quit";
import { menuTemplate } from "@/main/menu";
import { Panel } from "@/main/panel";
import { loginShellPath, QuaditCli } from "@/main/quadit-cli";
import { Requests } from "@/main/requests";
import { ServerChecks } from "@/main/server-checks";
import { ServerList } from "@/main/server-list";
import { ServerWindows } from "@/main/server-windows";
import { ServerStore } from "@/main/servers";
import { Settings } from "@/main/settings";
import { Setup } from "@/main/setup-page";
import { StoppedMark } from "@/main/stopped-mark";
import { refusedSwitches } from "@/main/switches";
import { Unread } from "@/main/unread";
import { isReleasePage, type Release, UpdateWatch } from "@/main/updates";
import { BRIDGE_REQUEST } from "@/shared/bridge";

const WEBSITE = "https://agrigoryan.github.io/quadit/";
const ISSUES = "https://github.com/agrigoryan/quadit/issues";

// QUADIT_DESKTOP_DATA keeps a whole profile (servers, sessions, window
// places) in another folder: for tests, and for trying a second profile.
if (process.env.QUADIT_DESKTOP_DATA) app.setPath("userData", process.env.QUADIT_DESKTOP_DATA);

/** Links that arrive before the app has started (macOS sends the one that launched it early). */
const earlyLinks: string[] = [];
let handleLink: (link: string) => void = (link) => void earlyLinks.push(link);

const refused = app.isPackaged ? refusedSwitches(process.argv, (name) => app.commandLine.hasSwitch(name)) : [];
if (refused.length > 0) {
  process.stderr.write(`${app.name} does not start with ${refused.map((name) => `--${name}`).join(", ")}.\n`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  // Another copy runs: it receives this one's arguments (and any link in them) as second-instance.
  app.quit();
} else {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleLink(url);
  });
  const launchLink = deepLinkInArgs(process.argv);
  if (launchLink) earlyLinks.push(launchLink);
  // Only the installed app claims the scheme: run from source it would name
  // the bare Electron binary, and a profile in another folder (a test) must
  // not take links from the installed one.
  if (app.isPackaged && !process.env.QUADIT_DESKTOP_DATA) app.setAsDefaultProtocolClient(SCHEME);
  void app.whenReady().then(start);
}

function start() {
  // The built code sits in out/ beside assets/, both inside the app (its asar when packaged).
  const outDir = __dirname;
  const pagesUrl = pathToFileURL(join(outDir, "pages") + "/").href;
  const version = app.getVersion();
  const dataDir = app.getPath("userData");
  const store = new ServerStore(join(dataDir, "servers.json"));
  const settings = new Settings(join(dataDir, "settings.json"));
  const pages = new AppPages(pagesUrl, join(outDir, "preload-pages.js"));
  const flows = new SignInFlows();

  enablePasskeys();

  // Started at login (macOS), or in the background by the quadit command, the app opens no window: it is there
  // for its server and its notifications. In the background it says nothing of its own either (no first run, no
  // dialog) until the person opens it; an `activate` its start brings opens no window.
  const atLogin = process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
  const starting = coldStart(process.argv, { atLogin });
  const quiet = new Quiet(starting.server === "background");
  const activated = new ActivateAfterStart(starting.server === "background");
  app.on("browser-window-focus", () => quiet.seen());

  // Quitting while a page uploads asks the person once (quit.ts); in the background nobody is there to answer, so
  // nothing waits and the quit goes through.
  const watchingUpdates = app.isPackaged || !!process.env.QUADIT_DESKTOP_CHECK_UPDATES;
  const quitting = new QuitGuard<WebContents>({
    ask: (page) => {
      const options = {
        type: "warning" as const,
        message: "A file is still uploading.",
        detail: "If you quit now, the upload is lost.",
        buttons: ["Don't quit", "Quit"],
        defaultId: 0,
        cancelId: 0,
      };
      const win = BrowserWindow.fromWebContents(page);
      const answer = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
      return answer === 1 ? "quit" : "stay";
    },
    inBackground: () => quiet.holding,
    stayed: () => {
      windows.stayOpen();
      if (watchingUpdates) updates.start();
    },
  });

  const fetcher = (url: string, init?: RequestInit) => net.fetch(url, init);
  const checks = new ServerChecks(store, fetcher, (words) => quiet.say(() => void warn(words)));
  const cli = new QuaditCli(bundledCli(), loginShellPath, { home: homedir(), shell: process.env.SHELL || "/bin/sh" });
  // The folder of the quadit logins, as the quadit the person's agents run says (else the app's own).
  const loginsFolder = async () => {
    const look = await cli.look();
    const binary = look.found?.path ?? cli.bundled;
    return binary ? dirname(await cli.defaultConfig(binary)) : null;
  };
  const local = new LocalServer({
    binary: localServerBinary(),
    dataDir: join(dataDir, "server"),
    settings,
    spawn: (binary, args, options) => spawn(binary, args, options),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
    fetch: fetcher,
    ports: loopbackPorts,
    env: process.env,
    shellPath: loginShellPath,
    stopped: new StoppedMark(loginsFolder),
  });
  // Offered on macOS, for the installed app only: from source it would start the bare Electron.
  const loginItem =
    process.platform === "darwin" && app.isPackaged
      ? {
          get: () => app.getLoginItemSettings().openAtLogin,
          set: (on: boolean) => app.setLoginItemSettings({ openAtLogin: on }),
        }
      : null;
  // Every way to start the browser sign-in (the bar, the server list, the
  // menu, a provider's address on the sign-in page) comes here, and only a
  // server that speaks this app's hand-off gets it.
  const signIn = (serverId: string) =>
    void checks.whyNoSignIn(serverId).then((refused) => {
      const server = store.get(serverId);
      if (refused) void warn(refused);
      else if (server) void shell.openExternal(flows.begin(server.id, server.origin, windows.waitingFor(server.id)));
    });

  let refreshMenu = () => {};
  const requests = new Requests(
    (page, message) => {
      const contents = webContents.fromId(page);
      if (!contents || contents.isDestroyed()) return false;
      contents.send(BRIDGE_REQUEST, message);
      return true;
    },
    () => pages.changed(),
  );
  const unread = new Unread(store, {
    trayIcon: join(app.getAppPath(), "assets", "trayTemplate.png"),
    openServer: (id) => windows.show(id),
    showServerList: () => list.show(),
    togglePanel: (tray) => panel.toggle(tray),
  });
  const windows = new ServerWindows(store, {
    version,
    bridgePreload: join(outDir, "preload-bridge.js"),
    pagesPreload: join(outDir, "preload-pages.js"),
    signInBarUrl: (serverId) => `${pagesUrl}sign-in-bar.html?server=${encodeURIComponent(serverId)}`,
    connectionErrorUrl: (words) => `${pagesUrl}connection-error.html?${new URLSearchParams(words)}`,
    signIn,
    reportUnread: (serverId, reporter, workspace, count) => unread.report(serverId, reporter, workspace, count),
    forgetUnread: (reporter) => unread.forget(reporter),
    requests,
    changed: () => refreshMenu(),
    whenReachable: (serverId) =>
      serverId === list.localServer()?.id ? local.whenRunning() : Promise.resolve({ ok: true as const }),
    openConnect: (serverId) => connect.asked(serverId),
    signInWithoutForm: (serverId, fetch) =>
      serverId === list.localServer()?.id ? local.signInOwner(fetch) : Promise.resolve(false),
    letUnload: (contents) => quitting.letGo(contents),
    isSignedIn: (serverId, fetch) =>
      serverId === list.localServer()?.id ? local.isSignedIn(fetch) : Promise.resolve(false),
  });
  const list = new ServerList(store, windows, pages, requests, {
    fetcher,
    checks,
    signIn,
    local,
    loginItem,
  });
  const panel = new Panel(pages, requests);
  const capture = new Capture(pages, settings, requests);
  const connections = new Connections({
    home: homedir(),
    dataDir,
    platform: process.platform,
    hostName: hostname(),
    cli,
    summaries: () => requests.summaries(),
    server: (id) => store.get(id),
    // The running app itself, which the quadit command starts: an AppImage by its own file, not where it is mounted.
    appFor: (id) => (id === list.localServer()?.id ? process.env.APPIMAGE || app.getPath("exe") : null),
    ask: (serverId, workspaceId, request) => requests.toWorkspace(serverId, workspaceId, request),
  });
  const connect = new ConnectPage({
    pages,
    connections,
    windows,
    target: (serverId) => {
      const server = store.get(serverId);
      const page = windows.pageOf(serverId);
      if (!server) return null;
      return { serverId, serverName: server.name, summary: page === undefined ? null : requests.summaryOf(page) };
    },
    copy: (text) => clipboard.writeText(text),
    showBackups: async () => {
      mkdirSync(connections.backupsDir, { recursive: true });
      await shell.openPath(connections.backupsDir);
    },
  });
  // The menu's Connect Agents… and setup's: over the server window in front, else one on screen, else the
  // server on this computer's, else the first server's, made and shown; with no server, the list to add one.
  const openConnect = () => {
    const server =
      windows.focused() ?? store.list().find((s) => windows.isShown(s.id)) ?? list.localServer() ?? store.list()[0];
    if (server) connect.show(server.id);
    else list.show();
  };
  const setup = new Setup({
    pages,
    settings,
    shortcut: () => capture.shortcut(),
    applyShortcut: () => capture.applyShortcut(),
    signedIn: () => [...new Set([...unread.showing(), ...requests.summaries().map((s) => s.serverId)])],
    openConnect,
  });
  const run = promisify(execFile);
  const firstRun = new FirstRun({
    pages,
    settings,
    store,
    list,
    windows,
    toolsStep: (serverId, workspace) =>
      new FirstConnect(
        {
          connections,
          summaries: () => requests.summaries(),
          ask: (server, workspaceId, request) => requests.toWorkspace(server, workspaceId, request),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        },
        serverId,
        workspace,
      ),
    accountName: () =>
      accountName(process.platform, userInfo().username, async (command, args) => {
        const { stdout } = await run(command, args, { timeout: 5_000 });
        return stdout;
      }),
  });

  const updates = new UpdateWatch(
    join(app.getPath("userData"), "update-check.json"),
    version,
    fetcher,
    () => refreshMenu(),
    (release) => quiet.say(() => void tellAboutUpdate(release)),
  );

  refreshMenu = () => {
    const front = windows.focused();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        menuTemplate(
          {
            appName: app.name,
            platform: process.platform,
            dev: !app.isPackaged,
            servers: store
              .list()
              .map((server) => ({ id: server.id, name: server.name, focused: server.id === front?.id })),
            serverInFront: !!front,
            update: updates.available,
            local: local.available
              ? { setUp: !!list.localServer(), state: local.state().kind, openAtLogin: loginItem?.get() ?? null }
              : null,
          },
          {
            showServerList: () => list.show(),
            showSetup: () => setup.show(),
            showConnect: openConnect,
            quickCapture: () => capture.toggle(),
            togglePanel: () => panel.toggle(unread.trayBounds()),
            openServer: (id) => windows.show(id),
            signInInFront: () => front && signIn(front.id),
            openUpdate: (release) => void tellAboutUpdate(release),
            openWebsite: () => void shell.openExternal(WEBSITE),
            reportIssue: () => void shell.openExternal(ISSUES),
            showWelcome: () => firstRun.show(),
            controlLocalServer: (control) => void list.control(control),
            showLocalServerFiles: (what) =>
              what === "log" ? shell.showItemInFolder(local.logFile) : void shell.openPath(local.dataDir),
            setOpenAtLogin: (on) => {
              loginItem?.set(on);
              refreshMenu();
              pages.changed();
            },
          },
        ),
      ),
    );
  };
  store.onChange(refreshMenu);
  app.on("browser-window-focus", refreshMenu);
  local.onChange(() => {
    refreshMenu();
    pages.changed();
    const entry = list.localServer();
    if (entry && local.state().kind === "running") {
      // Up: what it speaks is asked now, and a window that found it down tries again.
      void checks.check(entry.id);
      windows.serverStarted(entry.id);
      // Its set-up unfinished (the app quit during the first run, or an older version started it): the first run sets
      // it up, over its window, once the person has the app before them.
      quiet.say(() => void local.setupNeeded().then((needed) => needed && firstRun.show()));
    }
  });
  refreshMenu();

  const handleReadyLink = (raw: string) => {
    const link = parseDeepLink(raw);
    if (!link) return;
    if (link.kind === "connect") {
      const redeemed = flows.redeem(link);
      if (redeemed.ok) windows.finishSignIn(redeemed.serverId, redeemed.finishUrl, redeemed.next);
      else void dialog.showMessageBox({ type: "warning", message: "Sign-in not finished", detail: redeemed.reason });
      return;
    }
    const server = store.byOrigin(link.server);
    if (server) windows.show(server.id, link.path);
    else void offerToAdd(link.server).then((add) => add && list.invite(link.server, link.path));
  };

  app.on("second-instance", (_event, argv) => {
    const asked = secondStart(argv, { windowShown: BrowserWindow.getAllWindows().some((win) => win.isVisible()) });
    if (asked.kind === "link") handleLink(asked.link);
    else if (asked.kind === "background") {
      quiet.background();
      if (list.localServer()) void local.startInBackground();
    } else if (asked.kind === "list") list.show();
  });
  app.on("activate", () => {
    if (!activated.isThePersons()) return;
    if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) list.show();
  });
  app.on("before-quit", () => {
    quitting.quitBegan();
    windows.quit();
    updates.stop();
  });
  // Quitting is never held up: macOS quits this way for a logout too,
  // which waiting would cancel. The server on this computer is told to stop
  // and finishes on its own (local-server.ts). Only now that the windows
  // have closed: one may still keep the app (a page's beforeunload, during
  // an upload) after before-quit, and the server must not go under it.
  app.on("will-quit", () => local.stopWithoutWaiting());
  // Server windows hide rather than close, so this only runs when quitting
  // or when the server list was the last window on Windows and Linux. With
  // a server on this computer the app stays, in the menu bar or the tray,
  // since the server runs only while the app does.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !list.localServer()) app.quit();
  });

  // Asleep, a page's connections died quietly; awake, they are checked at once.
  powerMonitor.on("resume", () => windows.wake());
  unread.start();
  capture.applyShortcut();
  // Started before the windows are made, so that its window waits for it (whenReachable).
  if (list.localServer()) {
    if (starting.server === "start") local.start();
    else void local.startInBackground();
  }
  const shown = windows.restore({ show: starting.windows });
  if (!starting.windows) {
    // Nothing to show now; a first run owed is shown once the person opens the app (in the background), or at its
    // next start (at login).
    if (starting.server === "background") quiet.say(() => firstRun.due() && firstRun.show());
  } else if (firstRun.due()) firstRun.show();
  else if (!shown) list.show();
  // Servers upgrade and downgrade while the app is away: ask each again.
  void checks.checkAll();
  // The app may have been updated, and its quadit with it: the skills Connect wrote follow, silently, in the
  // background too. One not refreshed now (no quadit answered) is at the next start.
  void connections.refreshSkills().catch(() => {});
  if (watchingUpdates) updates.start();
  // Only now that the windows are made: making one can run the system's
  // event loop, which may hand in a link, and handled then it would make
  // the server list a second time while the first is still being made.
  handleLink = handleReadyLink;
  for (const link of earlyLinks.splice(0)) handleLink(link);
}

/**
 * A link asked to open a server the app is not connected to. It is never
 * added on a link's word: the person is told and may add it themselves.
 */
async function offerToAdd(origin: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: `This app is not connected to ${origin}`,
    detail: "A link asked to open a page there. Add the server only if you know it and want to use it in this app.",
    buttons: ["Add It…", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * The quadit command packaged in the app's resources (macOS and Linux), or
 * null without one: run from source, on Windows, and run as an AppImage,
 * whose files are mounted only while it runs, so a link to them would
 * break when the app quits.
 */
function bundledCli(): string | null {
  const path = join(process.resourcesPath, "bin", "quadit");
  return app.isPackaged && !process.env.APPIMAGE && existsSync(path) ? path : null;
}

/**
 * The quadit the app runs as the server on this computer: the one packaged
 * in its resources (macOS and Linux, built with the web app), or null
 * without one (Windows). Run from source, QUADIT_DESKTOP_QUADIT names one
 * (a binary `make build` made), for tests and for trying it out.
 */
function localServerBinary(): string | null {
  if (!app.isPackaged) return process.env.QUADIT_DESKTOP_QUADIT || null;
  const path = join(process.resourcesPath, "bin", "quadit");
  return existsSync(path) ? path : null;
}

/** Tells the person something that went wrong or needs them, in a dialog of its own. */
async function warn(words: { title: string; detail: string }) {
  await dialog.showMessageBox({ type: "warning", message: words.title, detail: words.detail });
}

/** Says a newer version is out and how to get it; the app installs nothing itself. */
async function tellAboutUpdate(release: Release) {
  const brew =
    process.platform === "darwin" ? "\n\nInstalled with Homebrew? Run: brew upgrade --cask quadit-desktop" : "";
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: `${app.name} ${release.version} is available`,
    detail: `You have ${app.getVersion()}. Download the new version from its release page.${brew}`,
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0 && isReleasePage(release.url)) void shell.openExternal(release.url);
}

/**
 * Passkeys inside the app (macOS): Touch ID passkeys kept in this Mac's
 * keychain, which needs the app signed with the keychain group its build
 * names (electron-builder.config.cjs). An unsigned build has none, so
 * passkeys stay off there and the browser sign-in is the way in. Synced
 * iCloud passkeys would need each server's domain in the app's signed
 * entitlements, which a self-hosted server cannot have.
 */
function enablePasskeys() {
  if (process.platform !== "darwin") return;
  const manifest = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
    quaditDesktop?: { keychainAccessGroup?: string };
  };
  const group = manifest.quaditDesktop?.keychainAccessGroup;
  if (!group) return;
  app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: "sign in to $1" } });
}

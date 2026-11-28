// The app's start: no switches that open it to other programs
// (switches.ts), one running copy, the quadit:// scheme, and the parts
// put together: the servers (servers.ts), their windows
// (server-windows.ts), what the windows' pages publish and are asked
// (requests.ts), the first run (first-run.ts), the app's own pages
// (app-pages.ts: the server list, setup, Connect agents, the menu-bar panel,
// quick capture), the browser sign-in
// (handoff.ts), the menu-bar icon and its number (menu-bar.ts), the menu (menu.ts), the
// update notice (updates.ts) and the server on this computer
// (local-server.ts), which runs while the app does. Started with
// --background (launch.ts), by the quadit command finding that server not
// running, it opens no window, as at login.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  powerMonitor,
  shell,
  type OpenDialogOptions,
  type WebContents,
  WebContentsView,
  webContents,
} from "electron";
import { accountName } from "@/main/account-name";
import { AppPages } from "@/main/app-pages";
import { Capture } from "@/main/capture";
import { childStarter } from "@/main/child-guard";
import { ConnectPage } from "@/main/connect-page";
import { Connections } from "@/main/connections";
import { deepLinkInArgs, parseDeepLink, SCHEME } from "@/main/deep-link";
import { FirstConnect } from "@/main/first-connect";
import { FirstRun } from "@/main/first-run";
import { SignInFlows } from "@/main/handoff";
import { HARNESSES } from "@/main/harnesses";
import { ActivateAfterStart, coldStart, Quiet, secondStart, windowsToReopen } from "@/main/launch";
import { LocalServer, loopbackPorts } from "@/main/local-server";
import { localAgents } from "@/main/local-agents";
import { appendLog } from "@/main/log-file";
import { menuTemplate } from "@/main/menu";
import { MenuBar } from "@/main/menu-bar";
import { Panel } from "@/main/panel";
import { loginShellPath, QuaditCli } from "@/main/quadit-cli";
import { QuitGuard } from "@/main/quit";
import { Requests } from "@/main/requests";
import { Runner } from "@/main/runner";
import { SelfRuns } from "@/main/self-runs";
import { ServerChecks } from "@/main/server-checks";
import { ServerList } from "@/main/server-list";
import { ServerWindows } from "@/main/server-windows";
import { ServerStore } from "@/main/servers";
import { Settings } from "@/main/settings";
import { Setup } from "@/main/setup-page";
import { StoppedMark } from "@/main/stopped-mark";
import { refusedSwitches } from "@/main/switches";
import { toolProgram } from "@/main/tool-program";
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
  // Every program the app holds besides its server starts this way: on Windows under the guard of the quadit it carries.
  const startChild = childStarter(process.platform, localServerBinary);
  const checks = new ServerChecks(store, fetcher, (words) => quiet.say(() => void warn(words)));
  const cli = new QuaditCli(bundledCli(), loginShellPath, {
    home: homedir(),
    shell: process.env.SHELL || "/bin/sh",
    platform: process.platform,
  });
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
    // What a page published changed: the app's pages, and the number of what waits on the person, follow.
    () => {
      pages.changed();
      menuBar.changed();
    },
  );
  const menuBar = new MenuBar(store, {
    // A template image is drawn in the bar's own colour on macOS only; elsewhere it would stay black, unseen on a dark
    // taskbar, so Windows shows the app's own icon.
    trayIcon: join(app.getAppPath(), "assets", process.platform === "win32" ? "icon.png" : "trayTemplate.png"),
    openServer: (id) => windows.show(id),
    showServerList: () => list.show(),
    togglePanel: (tray) => panel.toggle(tray),
    summaries: () => requests.summaries(),
  });
  const windows = new ServerWindows(store, {
    version,
    bridgePreload: join(outDir, "preload-bridge.js"),
    pagesPreload: join(outDir, "preload-pages.js"),
    signInBarUrl: (serverId) => `${pagesUrl}sign-in-bar.html?server=${encodeURIComponent(serverId)}`,
    connectionErrorUrl: (words) => `${pagesUrl}connection-error.html?${new URLSearchParams(words)}`,
    signIn,
    requests,
    changed: () => refreshMenu(),
    whenReachable: (serverId) =>
      serverId === list.localServer()?.id ? local.whenRunning() : Promise.resolve({ ok: true as const }),
    openConnect: (serverId, focus) => connect.asked(serverId, focus),
    localAgents: (serverId, workspaceId) =>
      localAgents(
        { connections, runner, log: (line) => appendLog(join(dataDir, "tools", "logs", "local-agents.log"), line) },
        serverId,
        workspaceId,
      ),
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
  const capture = new Capture(pages, settings, requests);
  const panel = new Panel(pages, requests, {
    openCapture: () => capture.toggle(),
    openAgent: (serverId, agent, intent) => connect.show(serverId, { agent, ...(intent ? { intent } : {}) }),
  });
  const connections = new Connections({
    home: homedir(),
    dataDir,
    platform: process.platform,
    hostName: hostname(),
    cli,
    summaries: () => requests.summaries(),
    server: (id) => store.get(id),
    serverAt: (origin) => store.byOrigin(origin)?.id ?? null,
    // The running app itself, which the quadit command starts: an AppImage by its own file, not where it is mounted.
    appFor: (id) => (id === list.localServer()?.id ? process.env.APPIMAGE || app.getPath("exe") : null),
    ask: (serverId, workspaceId, request) => requests.toWorkspace(serverId, workspaceId, request),
    // A code to give back, else a look at the tools.
    connected: (key, code) => void (code ? selfRuns.prove(key, code) : selfRuns.sync()),
    disconnected: (key) => selfRuns.disconnected(key),
    removeRuns: (of) => runner.remove({ of }),
    ownQuadit: localServerBinary,
  });
  // What the app runs by itself for the tools connected (desktop contract §11, third amendment): each tool's program
  // on the login shell's PATH, else its desktop app's copy, run once to give its connect code back. Looked at again at
  // each Connect, Disconnect, change of the server here and start.
  //
  // Whether a quadit login is the app's own server's: that server's address, and the app's mark (login --app). The
  // tool runs with that file, so it decides, never the ledger.
  const loginIsHere = (file: string): boolean => {
    const origin = list.localServer() ? local.origin() : null;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; app?: unknown };
      return !!origin && saved.url === origin && typeof saved.app === "object" && saved.app !== null;
    } catch {
      return false;
    }
  };
  // Where the apps are installed, whose copies of a tool's program are looked for after the login shell's PATH.
  const toolsWhere = (path: string[]) => ({
    home: homedir(),
    path,
    applications: ["/Applications", join(homedir(), "Applications")],
    platform: process.platform,
  });
  const selfRuns = new SelfRuns({
    look: async () => {
      const look = await cli.look();
      const tools = (await connections.selfRunTools()).flatMap((tool) => {
        const harness = HARNESSES.find((h) => h.id === tool.tool);
        if (!harness) return [];
        return [
          {
            key: tool.key,
            tool: tool.tool,
            name: harness.name,
            program: toolProgram(harness, toolsWhere(look.path)),
            oneShot: harness.oneShot ?? null,
            login: tool.login,
            quadit: { config: tool.config, workspace: tool.workspace },
            workspace: tool.workspaceName,
            here: loginIsHere(tool.login),
            ran: tool.ran,
            // Runs for the app's own server exist only while it runs as the app's child (never another program on its port).
            serverRuns: local.state().kind === "running",
          },
        ];
      });
      return { tools, path: look.path.join(delimiter) };
    },
    start: startChild,
    codeGivenBack: async (key) => {
      const ref = connections.connectionOf(key);
      return !!ref && (await connections.handshake(ref))?.state === "connected";
    },
    openCode: (key) => connections.waitingCodes().find((open) => open.key === key)?.code ?? null,
    newCode: async (key) => {
      const ref = connections.connectionOf(key);
      if (ref) await connections.newCode(ref);
    },
    ran: (key) => connections.markRan(key),
    dir: join(dataDir, "tools"),
    env: process.env,
    changed: () => pages.changed(),
  });
  // Quadit runs the agent for a task (agent-runs-contract.md §8.3): quadit run, as the quadit the app carries (the
  // one it runs as its server: run from source, QUADIT_DESKTOP_QUADIT's), supervised while the app runs.
  const runner = new Runner({
    quadit: localServerBinary,
    path: loginShellPath,
    env: process.env,
    home: homedir(),
    start: startChild,
    log: (line) => appendLog(join(dataDir, "tools", "logs", "quadit-run.log"), line),
    changed: () => pages.changed(),
  });
  const connect = new ConnectPage({
    pages,
    connections,
    windows,
    isLocal: (serverId) => serverId === list.localServer()?.id,
    target: (serverId) => {
      const server = store.get(serverId);
      const page = windows.pageOf(serverId);
      if (!server) return null;
      return { serverId, serverName: server.name, summary: page === undefined ? null : requests.summaryOf(page) };
    },
    copy: (text) => clipboard.writeText(text),
    selfRuns,
    showLog: async (path) => {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, "");
      await shell.openPath(path);
    },
    showBackups: async () => {
      mkdirSync(connections.backupsDir, { recursive: true });
      await shell.openPath(connections.backupsDir);
    },
    runner,
    programOf: async (id) => {
      const harness = HARNESSES.find((h) => h.id === id);
      return harness ? toolProgram(harness, toolsWhere((await cli.look()).path)) : null;
    },
    // A sheet of the window the page is laid over (as a view), else a dialog of its own.
    pickFolder: async (sender) => {
      const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
      const win = BaseWindow.getAllWindows().find((w) =>
        w.contentView.children.some((view) => view instanceof WebContentsView && view.webContents === sender),
      );
      const { canceled, filePaths } = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return canceled ? null : (filePaths[0] ?? null);
    },
    home: homedir(),
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
    signedIn: () => [...new Set(requests.summaries().map((s) => s.serverId))],
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
        const { stdout } = await run(command, args, { timeout: 5_000, windowsHide: true });
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
            togglePanel: () => panel.toggle(menuBar.trayBounds()),
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
    // Whatever it became (running, stopped on purpose, failed, its port taken), the tools' runs follow it: those
    // the app never ran give their codes back.
    void selfRuns.sync();
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

  // The person opens the app and no window is on screen: their workspaces, as a start shows them, else the list.
  const reopen = () => {
    const ids = windowsToReopen(store.list());
    if (ids.length === 0) list.show();
    else for (const id of ids) windows.show(id);
  };
  app.on("second-instance", (_event, argv) => {
    const asked = secondStart(argv, { windowShown: BrowserWindow.getAllWindows().some((win) => win.isVisible()) });
    if (asked.kind === "link") handleLink(asked.link);
    else if (asked.kind === "background") {
      quiet.background();
      if (list.localServer()) void local.startInBackground();
    } else if (asked.kind === "list") reopen();
  });
  app.on("activate", () => {
    if (!activated.isThePersons()) return;
    if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) reopen();
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
  app.on("will-quit", () => {
    // Every program the app started for its tools stops with it (child-guard.ts), as its server does; quadit run ends
    // the runs it started (Interrupted on their tasks: a comment continues them).
    selfRuns.quit();
    runner.quit();
    local.stopWithoutWaiting();
  });
  // Server windows hide rather than close, so this only runs when quitting
  // or when the server list was the last window on Windows and Linux. With
  // a server on this computer the app stays, in the menu bar or the tray,
  // since the server runs only while the app does.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !list.localServer()) app.quit();
  });

  // Asleep, a page's connections died quietly; awake, they are checked at once.
  powerMonitor.on("resume", () => windows.wake());
  menuBar.start();
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
  // The app may have been updated, and its quadit with it: the skills Connect wrote follow, and a tool connected
  // by a version from before is let use Quadit without asking, silently, in the background too. What is not done
  // now (no quadit answered) is at the next start.
  // Then a tool the app never ran gives its code back (a background start too), once the app's own server runs
  // (local.onChange); a tool of another server never does.
  void connections
    .refresh()
    .catch(() => {})
    .then(() => selfRuns.sync());
  // quadit run serves the projects registered on this computer for the agents' tasks, a background start too.
  void runner.sync();
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
 * The quadit command the app carries, which Connect puts on the PATH when
 * the person has none: the one packaged in its resources, or null without
 * one, and run as an AppImage, whose files are mounted only while it runs,
 * so a link to them would break when the app quits. Run from source,
 * QUADIT_DESKTOP_QUADIT's, as for its server (for tests and trying out). On
 * Windows the installer keeps the resources in the same folder across
 * updates (the place of the first install, which it reads back), so the
 * folder Connect adds to the PATH still holds quadit.exe after one.
 */
function bundledCli(): string | null {
  if (!app.isPackaged) return process.env.QUADIT_DESKTOP_QUADIT || null;
  const path = packagedQuadit();
  return !process.env.APPIMAGE && existsSync(path) ? path : null;
}

/**
 * The quadit the app runs as the server on this computer: the one packaged
 * in its resources (built with the web app), or null without one. Run from
 * source, QUADIT_DESKTOP_QUADIT names one (a binary `make build` made), for
 * tests and for trying it out.
 */
function localServerBinary(): string | null {
  if (!app.isPackaged) return process.env.QUADIT_DESKTOP_QUADIT || null;
  const path = packagedQuadit();
  return existsSync(path) ? path : null;
}

/** Where the packaging puts quadit in the app's resources (electron-builder.config.cjs). */
function packagedQuadit(): string {
  return join(process.resourcesPath, "bin", process.platform === "win32" ? "quadit.exe" : "quadit");
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

// The app's start: no switches that open it to other programs
// (switches.ts), one running copy, the quadit:// scheme, and the parts
// put together: the servers (servers.ts), their windows
// (server-windows.ts), what the windows' pages publish and are asked
// (requests.ts), the app's own pages (app-pages.ts: the server list,
// setup, Connect, the menu-bar panel, quick capture), the browser sign-in
// (handoff.ts), the unread badge (unread.ts), the menu (menu.ts) and the
// update notice (updates.ts).

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, net, powerMonitor, shell, webContents } from "electron";
import { AppPages } from "@/main/app-pages";
import { Capture } from "@/main/capture";
import { ConnectPage } from "@/main/connect-page";
import { Connections } from "@/main/connections";
import { deepLinkInArgs, parseDeepLink, SCHEME } from "@/main/deep-link";
import { SignInFlows } from "@/main/handoff";
import { menuTemplate } from "@/main/menu";
import { Panel } from "@/main/panel";
import { loginShellPath, QuaditCli } from "@/main/quadit-cli";
import { Requests } from "@/main/requests";
import { ServerChecks } from "@/main/server-checks";
import { ServerList } from "@/main/server-list";
import { ServerWindows } from "@/main/server-windows";
import { ServerStore } from "@/main/servers";
import { Settings, Setup } from "@/main/setup-settings";
import { refusedSwitches } from "@/main/switches";
import { Unread } from "@/main/unread";
import { isReleasePage, type Release, UpdateWatch } from "@/main/updates";
import { BRIDGE_REQUEST } from "@/shared/bridge";

const WEBSITE = "https://github.com/agrigoryan/quadit";

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

  const fetcher = (url: string, init?: RequestInit) => net.fetch(url, init);
  const checks = new ServerChecks(store, fetcher, (words) => void warn(words));
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
  });
  const list = new ServerList(store, windows, pages, requests, { fetcher, checks, signIn });
  const panel = new Panel(pages, requests);
  const capture = new Capture(pages, settings, requests);
  const connect = new ConnectPage(
    pages,
    new Connections({
      home: homedir(),
      dataDir,
      platform: process.platform,
      hostName: hostname(),
      cli: new QuaditCli(bundledCli(), loginShellPath),
      summaries: () => requests.summaries(),
      server: (id) => store.get(id),
      ask: (serverId, workspaceId, request) => requests.toWorkspace(serverId, workspaceId, request),
    }),
  );
  const setup = new Setup({
    pages,
    settings,
    shortcut: () => capture.shortcut(),
    applyShortcut: () => capture.applyShortcut(),
    signedIn: () => [...new Set([...unread.showing(), ...requests.summaries().map((s) => s.serverId)])],
    openConnect: () => connect.show(),
  });

  const updates = new UpdateWatch(
    join(app.getPath("userData"), "update-check.json"),
    version,
    fetcher,
    () => refreshMenu(),
    (release) => void tellAboutUpdate(release),
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
          },
          {
            showServerList: () => list.show(),
            showSetup: () => setup.show(),
            showConnect: () => connect.show(),
            quickCapture: () => capture.toggle(),
            togglePanel: () => panel.toggle(unread.trayBounds()),
            openServer: (id) => windows.show(id),
            signInInFront: () => front && signIn(front.id),
            openUpdate: (release) => void tellAboutUpdate(release),
            openWebsite: () => void shell.openExternal(WEBSITE),
            reportIssue: () => void shell.openExternal(`${WEBSITE}/issues`),
          },
        ),
      ),
    );
  };
  store.onChange(refreshMenu);
  app.on("browser-window-focus", refreshMenu);
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
    const link = deepLinkInArgs(argv);
    if (link) handleLink(link);
    else if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) list.show();
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) list.show();
  });
  app.on("before-quit", () => {
    windows.quit();
    updates.stop();
  });
  // Server windows hide rather than close, so this only runs when quitting
  // or when the server list was the last window on Windows and Linux.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Asleep, a page's connections died quietly; awake, they are checked at once.
  powerMonitor.on("resume", () => windows.wake());
  unread.start();
  capture.applyShortcut();
  const shown = windows.restore();
  if (!settings.get().setupDone) setup.show();
  else if (!shown) list.show();
  // Servers upgrade and downgrade while the app is away: ask each again.
  void checks.checkAll();
  if (app.isPackaged || process.env.QUADIT_DESKTOP_CHECK_UPDATES) updates.start();
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

/** The quadit command packaged in the app's resources (macOS and Linux), or null without one (run from source, Windows). */
function bundledCli(): string | null {
  const path = join(process.resourcesPath, "bin", "quadit");
  return app.isPackaged && existsSync(path) ? path : null;
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

// The app's start: one running copy, the quadit:// scheme, and the parts
// put together: the servers (servers.ts), their windows
// (server-windows.ts), the server list page (server-list.ts), the browser
// sign-in (handoff.ts), the unread badge (unread.ts), the menu (menu.ts)
// and the update notice (updates.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, net, shell } from "electron";
import { deepLinkInArgs, parseDeepLink, SCHEME } from "@/main/deep-link";
import { SignInFlows } from "@/main/handoff";
import { menuTemplate } from "@/main/menu";
import { ServerList } from "@/main/server-list";
import { ServerWindows } from "@/main/server-windows";
import { ServerStore } from "@/main/servers";
import { Unread } from "@/main/unread";
import { type Release, UpdateWatch } from "@/main/updates";

const WEBSITE = "https://github.com/agrigoryan/quadit";

// QUADIT_DESKTOP_DATA keeps a whole profile (servers, sessions, window
// places) in another folder: for tests, and for trying a second profile.
if (process.env.QUADIT_DESKTOP_DATA) app.setPath("userData", process.env.QUADIT_DESKTOP_DATA);

/** Links that arrive before the app is ready (macOS sends the one that launched it early). */
const earlyLinks: string[] = [];
let handleLink = (link: string) => void earlyLinks.push(link);

if (!app.requestSingleInstanceLock()) {
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
  const store = new ServerStore(join(app.getPath("userData"), "servers.json"));
  const flows = new SignInFlows();

  enablePasskeys();

  const signIn = (serverId: string) => {
    const server = store.get(serverId);
    if (server) void shell.openExternal(flows.begin(server.id, server.origin));
  };

  let refreshMenu = () => {};
  const unread = new Unread(store, {
    trayIcon: join(app.getAppPath(), "assets", "trayTemplate.png"),
    openServer: (id) => windows.show(id),
    showServerList: () => list.show(),
  });
  const windows = new ServerWindows(store, {
    version,
    bridgePreload: join(outDir, "preload-bridge.js"),
    pagesPreload: join(outDir, "preload-pages.js"),
    signInBarUrl: (serverId) => `${pagesUrl}sign-in-bar.html?server=${encodeURIComponent(serverId)}`,
    signIn,
    setUnread: (serverId, count) => unread.set(serverId, count),
    changed: () => refreshMenu(),
  });
  const list = new ServerList(store, windows, {
    pagesPreload: join(outDir, "preload-pages.js"),
    pagesUrl,
    fetcher: (url, init) => net.fetch(url, init),
    signIn,
  });

  const updates = new UpdateWatch(
    join(app.getPath("userData"), "update-check.json"),
    version,
    (url, init) => net.fetch(url, init),
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

  handleLink = (raw) => {
    const link = parseDeepLink(raw);
    if (!link) return;
    if (link.kind === "connect") {
      const redeemed = flows.redeem(link);
      if (redeemed.ok) windows.finishSignIn(redeemed.serverId, redeemed.finishUrl);
      else void dialog.showMessageBox({ type: "warning", message: "Sign-in not finished", detail: redeemed.reason });
      return;
    }
    const server = store.byOrigin(link.server);
    if (server) windows.show(server.id, link.path);
    else list.invite(link.server);
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

  unread.start();
  if (!windows.restore()) list.show();
  if (app.isPackaged || process.env.QUADIT_DESKTOP_CHECK_UPDATES) updates.start();
  for (const link of earlyLinks.splice(0)) handleLink(link);
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
  if (response === 0) void shell.openExternal(release.url);
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

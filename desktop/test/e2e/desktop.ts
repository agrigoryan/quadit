// The `test` every desktop spec imports: Playwright's, with the app started
// fresh for each test (its own empty data folder, the first run marked over
// unless a test asks for the first start, which shows the first run) and some things of the main process
// stood in for from its start (stand-ins.cjs), so nothing leaves the test
// and what the app did can be read back.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test as base } from "@playwright/test";
import { currentRun, OWNER, type Run } from "./run";

export { expect } from "@playwright/test";

const APP_DIR = join(__dirname, "../..");

/**
 * Where the suite saves the pictures the owner sees before a build, outside
 * test-results (which Playwright empties at every run); desktop-ci keeps the
 * folder on every run as the artifact desktop-onboarding-screens.
 */
export const SCREENS = join(__dirname, "../../onboarding-screens");

/** Saves what `page` shows as `name` in SCREENS, as it is meant to look once a card or a sheet has finished fading in. */
export async function screen(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, name), animations: "disabled" });
}

/** The app's own version (package.json), which its pages are told through the bridge. */
export const APP_VERSION: string = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")).version;

export interface Recorded {
  opened: string[];
  notes: { title: string; body: string }[];
  dialogs: string[];
}

export class Desktop {
  constructor(
    public app: ElectronApplication,
    readonly data: string,
    readonly run: Run,
  ) {}

  /**
   * Starts the app from out/ on the data folder `data`, with the stand-ins
   * in place. `args` are given to it as a system gives a link that starts
   * the app (Windows and Linux; macOS reads the same argument at start);
   * `env` is added to its environment. A data folder without settings gets
   * the first run marked over (none shown), unless `firstStart`.
   */
  static async launch(
    data: string,
    run: Run,
    args: string[] = [],
    { env = {}, firstStart = false }: { env?: Record<string, string>; firstStart?: boolean } = {},
  ): Promise<Desktop> {
    const settings = join(data, "settings.json");
    if (!firstStart && !existsSync(settings)) writeFileSync(settings, JSON.stringify({ setupDone: true }));
    const app = await electron.launch({
      // Chromium's stand-in keychain: a test never touches the person's login keychain, which
      // would stop the app on a prompt when another build of it made the key there.
      args: ["-r", join(__dirname, "stand-ins.cjs"), "--use-mock-keychain", APP_DIR, ...args],
      env: { ...process.env, ...env, QUADIT_DESKTOP_DATA: data },
    });
    return new Desktop(app, data, run);
  }

  async recorded(): Promise<Recorded> {
    return this.app.evaluate(() => {
      const { opened, notes, dialogs } = (
        globalThis as unknown as { e2e: { opened: string[]; notes: Electron.Notification[]; dialogs: string[] } }
      ).e2e;
      return { opened, notes: notes.map((note) => ({ title: note.title, body: note.body })), dialogs };
    });
  }

  /** Clicks the last notification shown, as a person clicking it in the notification centre. */
  async clickLastNotification() {
    await this.app.evaluate(() => {
      const { notes } = (globalThis as unknown as { e2e: { notes: Electron.Notification[] } }).e2e;
      notes.at(-1)?.emit("click");
    });
  }

  /** The buttons of the last notification shown, and whether it has a reply field. */
  async lastNotificationOffers(): Promise<{ actions: string[]; reply: boolean }> {
    return this.app.evaluate(() => {
      const { notes } = (globalThis as unknown as { e2e: { notes: Electron.Notification[] } }).e2e;
      const note = notes.at(-1);
      return { actions: (note?.actions ?? []).map((a) => a.text ?? ""), reply: !!note?.hasReply };
    });
  }

  /** Presses the button `index` of the last notification, as macOS reports it. */
  async pressNotificationAction(index: number) {
    await this.app.evaluate((_electron, actionIndex) => {
      const { notes } = (globalThis as unknown as { e2e: { notes: Electron.Notification[] } }).e2e;
      notes.at(-1)?.emit("action", { actionIndex, selectionIndex: -1 }, actionIndex);
    }, index);
  }

  /** Sends `text` from the last notification's reply field, as macOS reports it. */
  async replyToNotification(text: string) {
    await this.app.evaluate((_electron, reply) => {
      const { notes } = (globalThis as unknown as { e2e: { notes: Electron.Notification[] } }).e2e;
      notes.at(-1)?.emit("reply", { reply }, reply);
    }, text);
  }

  /** Chooses the application menu's item `id`, as a person choosing it, once the app has put its menu up. */
  async chooseMenuItem(id: string) {
    const item = () => this.app.evaluate(({ Menu }, id) => !!Menu.getApplicationMenu()?.getMenuItemById(id), id);
    await expect.poll(item, { message: `the menu item ${id}` }).toBe(true);
    await this.app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
  }

  /** One of the app's own pages (`file` in out/pages), waiting for it to appear. */
  async appPage(file: string): Promise<Page> {
    return this.pageOf("file://", join(APP_DIR, "out/pages", file));
  }

  /** Has the app's next dialog answered with its button `index`, as a person pressing it (by default, its cancel button). */
  async answerNextDialog(index: number) {
    await this.app.evaluate((_electron, button) => {
      (globalThis as unknown as { e2e: { answers: number[] } }).e2e.answers.push(button);
    }, index);
  }

  /** Hands the app a quadit:// link the way macOS does. */
  async openLink(url: string) {
    await this.app.evaluate(({ app }, link) => app.emit("open-url", { preventDefault() {} }, link), url);
  }

  /** The window (or view) showing a page of `origin`, waiting for it to appear. */
  async pageOf(origin: string, path = ""): Promise<Page> {
    let found: Page | undefined;
    await expect
      .poll(() => (found = this.app.windows().find((page) => page.url().startsWith(origin + path))), {
        message: `a window at ${origin}${path}`,
      })
      .toBeTruthy();
    return found as Page;
  }

  /** The first run's page, laid over the window it ends in. */
  async firstRun(): Promise<Page> {
    return this.appPage("first-run.html");
  }

  /** Whether the first run's page is there. */
  firstRunShown(): boolean {
    return this.app.windows().some((page) => page.url().endsWith("/first-run.html"));
  }

  /** The ids of the app's windows on screen, whatever they show. */
  async shownWindows(): Promise<number[]> {
    return this.app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .filter((w) => w.isVisible())
        .map((w) => w.id),
    );
  }

  /** The server list window. */
  async serverList(): Promise<Page> {
    return this.appPage("servers.html");
  }

  /** The bar over a server window's sign-in page. */
  async signInBar(): Promise<Page> {
    return this.appPage("sign-in-bar.html");
  }

  /**
   * Signs the server at `origin` in with the owner's session from the first
   * run (put in its window's partition, as a sign-in would) and gives its
   * window on the workspace. For tests about something other than signing in.
   */
  async signedIn(origin: string): Promise<Page> {
    const partition = `persist:server-${this.serverId(origin)}`;
    const { name, value } = this.run.session;
    // Kept for a day and written out at once, as the server's own cookie is kept: a start of the
    // app again in the same data folder is still signed in.
    await this.app.evaluate(
      async ({ session }, cookie) => {
        const { cookies } = session.fromPartition(cookie.partition);
        await cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          httpOnly: true,
          expirationDate: Date.now() / 1000 + 24 * 60 * 60,
        });
        await cookies.flushStore();
      },
      { partition, url: origin, name, value },
    );
    const page = await this.pageOf(origin);
    await page.goto(`${origin}/e2e/my-work`);
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
    return page;
  }

  /** Closes the window of the server at `origin`, which hides it: its page keeps running, out of the person's sight. */
  async hide(origin: string) {
    await this.app.evaluate(
      ({ BrowserWindow }, wanted) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().startsWith(wanted))
          ?.close(),
      origin,
    );
    await expect.poll(() => this.isShown(origin)).toBe(false);
  }

  /** Whether the window of the server at `origin` is on screen. */
  async isShown(origin: string): Promise<boolean> {
    return this.app.evaluate(
      ({ BrowserWindow }, wanted) =>
        !!BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().startsWith(wanted))
          ?.isVisible(),
      origin,
    );
  }

  /** The addresses of the app's own pages laid over the window of the server at `origin` (the sign-in bar, Connect agents…), shown or not. */
  async overlays(origin: string): Promise<string[]> {
    return this.app.evaluate(({ BrowserWindow, WebContentsView }, wanted) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(wanted));
      return (win?.contentView.children ?? []).flatMap((view) =>
        view instanceof WebContentsView ? [view.webContents.getURL()] : [],
      );
    }, origin);
  }

  /** Sets the size of the window of the server at `origin`, and gives its content's height. */
  async resize(origin: string, width: number, height: number): Promise<number> {
    return this.app.evaluate(
      ({ BrowserWindow }, { wanted, width, height }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(wanted));
        if (!win) throw new Error(`no window of ${wanted}`);
        win.setSize(width, height);
        return win.getContentBounds().height;
      },
      { wanted: origin, width, height },
    );
  }

  /** Whether one of the app's own pages (the sign-in bar, the connection error) shows over the window of the server at `origin`. */
  async overlayShown(origin: string): Promise<boolean> {
    return this.app.evaluate(({ BrowserWindow }, wanted) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(wanted));
      return !!win?.contentView.children.some((view) => view.getVisible());
    }, origin);
  }

  /** Adds a server through the server list and gives its window. */
  async addServer(address: string, name = ""): Promise<Page> {
    const list = await this.serverList();
    await list.getByLabel("Address").fill(address);
    await list.getByLabel("Name").fill(name);
    await list.getByRole("button", { name: "Add server" }).click();
    return this.pageOf(new URL(address).origin);
  }

  /** The address of the server the app runs on this computer, once it has chosen its port (its settings file). */
  async localOrigin(): Promise<string> {
    const port = () => {
      try {
        return (
          (JSON.parse(readFileSync(join(this.data, "settings.json"), "utf8")) as { localPort?: number }).localPort ?? 0
        );
      } catch {
        return 0;
      }
    };
    await expect.poll(port, { message: "the port of the server on this computer" }).toBeGreaterThan(0);
    return `http://127.0.0.1:${port()}`;
  }

  /** The id the app gave the server at `origin`, from its servers file. */
  serverId(origin: string): string {
    const { servers } = JSON.parse(readFileSync(join(this.data, "servers.json"), "utf8")) as {
      servers: { id: string; origin: string }[];
    };
    return servers.find((server) => server.origin === origin)?.id ?? "";
  }

  /** The count the app last put on its dock badge. */
  async badge(): Promise<number> {
    return this.app.evaluate(() => (globalThis as unknown as { e2e: { badge: number } }).e2e.badge);
  }

  /**
   * Closes the app, failing the test on any exception its main process did
   * not catch. The servers' service workers are let go first: started again
   * under Playwright, which attaches to every worker before it may run, a
   * worker is not always let run, and the next start's first page waits for
   * it for ever. The app on its own starts them again without fail.
   */
  async close() {
    const errors = await this.app
      .evaluate(() => (globalThis as unknown as { e2e: { errors: string[] } }).e2e.errors)
      .catch(() => []);
    for (const page of this.app.windows().filter((p) => p.url().startsWith("http"))) {
      await page
        .evaluate(async () => {
          for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
        })
        .catch(() => {}); // A page that is going or gone has nothing to let go.
    }
    await this.app.close();
    expect(errors, "exceptions the app's main process did not catch").toEqual([]);
  }
}

/**
 * The quadit `binary`, started `seconds` late: a start a person waits
 * through, long enough to be seen, or to quit the app during. Its input
 * reaches the server untouched (exec), app key and all.
 */
export function slowToStart(binary: string, seconds: number): string {
  const script = join(mkdtempSync(join(tmpdir(), "quadit-desktop-slow-")), "quadit");
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\nexec '${binary}' "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}

/**
 * A computer of the test's own for Connect: a home folder, a login shell
 * that says its PATH holds `bin`, and a quadit there that does what Connect
 * runs; with Claude Code's config folder in that home unless `claudeCode`
 * is false, when no agent tool is found there. Given to the app as HOME and
 * SHELL; nothing outside the test's folders is touched.
 */
export function fakeComputer({ claudeCode = true }: { claudeCode?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-connect-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  if (claudeCode) mkdirSync(join(home, ".claude"));
  mkdirSync(bin);
  const configDir = join(home, "Library", "Application Support", "quadit");
  const shell = join(root, "shell");
  writeFileSync(shell, `#!/bin/sh\necho "PATH=${bin}:/usr/bin:/bin"\n`);
  writeFileSync(
    join(bin, "quadit"),
    `#!/bin/sh
default='${join(configDir, "config.json")}'
case "$1" in
  version) echo "quadit 9.9.9 (agent surface 2.0)" ;;
  skill) printf '# Quadit skill\\n' ;;
  login)
    if [ "$2" = "--path" ]; then echo "\${QUADIT_CONFIG:-$default}"; exit 0; fi
    [ "$3" = "-" ] || exit 2
    read -r token
    config="\${QUADIT_CONFIG:-$default}"
    mkdir -p "$(dirname "$config")"
    printf '{"url":"%s","token":"%s"}\\n' "$2" "$token" > "$config"
    chmod 600 "$config" ;;
esac
`,
  );
  chmodSync(shell, 0o755);
  chmodSync(join(bin, "quadit"), 0o755);
  if (claudeCode)
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  return { root, home, configDir, shell };
}

/**
 * A sign-in code someone made for their own account, with a verifier of
 * their own: what an attacker who has an account on the server can put in
 * a link to sign the app in as themselves.
 */
export async function attackersCode(run: Run): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  let answer: Response;
  if (run.server === run.fake) {
    answer = await fetch(`${run.fake}/desktop/connect?state=${state}&challenge=${challenge}`, { redirect: "manual" });
  } else {
    const cookie = `${run.session.name}=${run.session.value}`;
    const me = (await (await fetch(`${run.server}/api/v1/auth/me`, { headers: { cookie } })).json()) as {
      user: { id: string };
    };
    answer = await fetch(`${run.server}/desktop/connect`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: run.server,
      },
      body: new URLSearchParams({ state, challenge, user: me.user.id }),
    });
  }
  const code = new URL(answer.headers.get("location") ?? "quadit://connect").searchParams.get("code") ?? "";
  expect(code).not.toBe("");
  return { code, verifier };
}

/** Whether a code is still unspent: trades it, as the app's own hand-off does, and says whether that signed in. */
export async function stillRedeemable(run: Run, code: string, verifier: string): Promise<boolean> {
  const answer = await fetch(`${run.server}/desktop/finish?${new URLSearchParams({ code, verifier })}`, {
    redirect: "manual",
    headers: { "user-agent": "Mozilla/5.0 Chrome/142.0 QuaditDesktop/0.1.0", "x-quadit-handoff": "1" },
  });
  return answer.status === 302;
}

/** Signs in with the owner's password on the sign-in page `page` shows, and waits for the workspace. */
export async function signInWithPassword(page: Page) {
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/e2e(\/|$)/);
}

export const test = base.extend<{ desktop: Desktop; run: Run }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from this pattern; it has none.
  run: async ({}, use) => use(currentRun()),
  desktop: async ({ run }, use) => {
    const desktop = await Desktop.launch(mkdtempSync(join(tmpdir(), "quadit-desktop-app-")), run);
    await use(desktop);
    await desktop.close();
  },
});

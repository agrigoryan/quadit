// The `test` every desktop spec imports: Playwright's, with the app started
// fresh for each test (its own empty data folder) and three things of the
// main process stood in for from its start (stand-ins.cjs), so nothing
// leaves the test and what the app did can be read back.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test as base } from "@playwright/test";
import { currentRun, OWNER, type Run } from "./run";

export { expect } from "@playwright/test";

const APP_DIR = join(__dirname, "../..");

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
   * the app (Windows and Linux; macOS reads the same argument at start).
   */
  static async launch(data: string, run: Run, args: string[] = []): Promise<Desktop> {
    const app = await electron.launch({
      // Chromium's stand-in keychain: a test never touches the person's login keychain, which
      // would stop the app on a prompt when another build of it made the key there.
      args: ["-r", join(__dirname, "stand-ins.cjs"), "--use-mock-keychain", APP_DIR, ...args],
      env: { ...process.env, QUADIT_DESKTOP_DATA: data },
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

  /** The server list window. */
  async serverList(): Promise<Page> {
    return this.pageOf("file://", join(APP_DIR, "out/pages/servers.html"));
  }

  /** The bar over a server window's sign-in page. */
  async signInBar(): Promise<Page> {
    return this.pageOf("file://", join(APP_DIR, "out/pages/sign-in-bar.html"));
  }

  /**
   * Signs the server at `origin` in with the owner's session from the first
   * run (put in its window's partition, as a sign-in would) and gives its
   * window on the workspace. For tests about something other than signing in.
   */
  async signedIn(origin: string): Promise<Page> {
    const partition = `persist:server-${this.serverId(origin)}`;
    const { name, value } = this.run.session;
    await this.app.evaluate(
      ({ session }, cookie) =>
        session
          .fromPartition(cookie.partition)
          .cookies.set({ url: cookie.url, name: cookie.name, value: cookie.value, httpOnly: true }),
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

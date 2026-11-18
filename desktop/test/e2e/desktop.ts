// The `test` every desktop spec imports: Playwright's, with the app started
// fresh for each test (its own empty data folder) and three things of the
// main process stood in for, so nothing leaves the test and what the app
// did can be read back:
//
//   shell.openExternal          records the address instead of opening the system browser
//   Notification.prototype.show records the notification instead of showing it
//   dialog.showMessageBox       records the message and answers "Later"

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

  /** Starts the app (from out/, or `executable` when given) on the data folder `data`, with the stand-ins in place. */
  static async launch(data: string, run: Run, executable?: string): Promise<Desktop> {
    const app = await electron.launch({
      ...(executable ? { executablePath: executable, args: [] } : { args: [APP_DIR] }),
      env: { ...process.env, QUADIT_DESKTOP_DATA: data },
    });
    await app.evaluate(({ dialog, Notification, shell }) => {
      const recorded = { opened: [] as string[], notes: [] as Electron.Notification[], dialogs: [] as string[] };
      Object.assign(globalThis, { e2e: recorded });
      shell.openExternal = async (url: string) => void recorded.opened.push(url);
      Notification.prototype.show = function show(this: Electron.Notification) {
        recorded.notes.push(this);
      };
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.MessageBoxOptions;
        recorded.dialogs.push(`${options.message} ${options.detail ?? ""}`.trim());
        return { response: 1, checkboxChecked: false };
      };
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

  /** Whether the sign-in bar shows over the window of the server at `origin`. */
  async barShown(origin: string): Promise<boolean> {
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

  async badge(): Promise<number> {
    return this.app.evaluate(({ app }) => app.getBadgeCount());
  }

  async close() {
    await this.app.close();
  }
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

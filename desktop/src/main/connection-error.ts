// What a server's window shows when its page cannot be loaded at all
// (offline at start, the server down, a name that does not resolve, a
// certificate this computer does not trust): the app's own page over the
// window, saying so, with Try again. It tries again on its own too, a little
// later each time, at once when the computer wakes, and when the network
// comes back (the page hears that and asks). A certificate is never let
// through: trying again is the only way past one, once it is fixed.
//
// A page that loaded and then lost its server is the web app's business:
// it has its own offline handling.

import { BrowserWindow, WebContentsView } from "electron";

/** Chromium's error for a load that was replaced by another, which is no failure. */
const ABORTED = -3;
const FIRST_RETRY_MS = 10_000;
const LAST_RETRY_MS = 60_000;

export interface ConnectionErrorSetup {
  pagesPreload: string;
  /** The bundled error page, with what it says in its query. */
  pageUrl(words: { name: string; origin: string; reason: string }): string;
}

interface Failure {
  url: string;
  view: WebContentsView;
  timer: ReturnType<typeof setTimeout> | undefined;
  tries: number;
}

export class ConnectionErrors {
  private failures = new Map<BrowserWindow, Failure>();

  constructor(private setup: ConnectionErrorSetup) {}

  /** Watches a server's window: a failed load of its page shows the error over it until a load works. */
  watch(win: BrowserWindow, server: () => { name: string; origin: string } | undefined) {
    const contents = win.webContents;
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      const known = server();
      if (!isMainFrame || code === ABORTED || !known) return;
      this.show(win, url, { name: known.name, origin: known.origin, reason: reasonOf(code, description) });
    });
    contents.on("did-navigate", (_event, url) => {
      const known = server();
      if (known && URL.parse(url)?.origin === known.origin) this.clear(win);
    });
    win.on("resize", () => this.place(win));
    win.on("closed", () => this.clear(win));
  }

  /** Tries every failed window again now: the computer woke, or the network came back. */
  retryAll() {
    for (const win of this.failures.keys()) this.retry(win);
  }

  /** Tries again the window whose error page is `contents` (its Try again). */
  retryFrom(contents: Electron.WebContents) {
    for (const [win, failure] of this.failures) if (failure.view.webContents === contents) this.retry(win);
  }

  private show(win: BrowserWindow, url: string, words: { name: string; origin: string; reason: string }) {
    let failure = this.failures.get(win);
    if (!failure) {
      const view = new WebContentsView({
        webPreferences: {
          preload: this.setup.pagesPreload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      view.webContents.on("will-navigate", (event) => event.preventDefault());
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.contentView.addChildView(view);
      failure = { url, view, timer: undefined, tries: 0 };
      this.failures.set(win, failure);
    }
    failure.url = url;
    void failure.view.webContents.loadURL(this.setup.pageUrl(words));
    this.place(win);
    // Later each time, up to a minute.
    clearTimeout(failure.timer);
    const wait = Math.min(FIRST_RETRY_MS * 2 ** failure.tries, LAST_RETRY_MS);
    failure.timer = setTimeout(() => this.retry(win), wait);
  }

  private retry(win: BrowserWindow) {
    const failure = this.failures.get(win);
    if (!failure || win.isDestroyed()) return;
    failure.tries++;
    clearTimeout(failure.timer);
    // A failure shows the page again, with the next wait; a success clears it (did-navigate).
    void win.webContents.loadURL(failure.url).catch(() => {});
  }

  private clear(win: BrowserWindow) {
    const failure = this.failures.get(win);
    if (!failure) return;
    this.failures.delete(win);
    clearTimeout(failure.timer);
    if (!win.isDestroyed()) win.contentView.removeChildView(failure.view);
    failure.view.webContents.close();
  }

  /** The error page covers the whole window. */
  private place(win: BrowserWindow) {
    const failure = this.failures.get(win);
    if (!failure || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    failure.view.setBounds({ x: 0, y: 0, width, height });
  }
}

/** What went wrong, in a sentence, from Chromium's error code and name. */
function reasonOf(code: number, description: string): string {
  // Chromium's certificate errors are -200 to -299.
  if (code <= -200 && code > -300) {
    return `Its certificate is not trusted by this computer (${description}). The app opens only servers it can verify; once the certificate is fixed, try again.`;
  }
  return `Check your connection and that the server is running (${description}).`;
}

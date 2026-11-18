// The app's own bundled pages (src/pages): the windows that show them, held
// to one set of rules, and the IPC that answers them. Only frames loaded
// from the app's own page files are answered, and these pages never leave
// their file: a navigation or window.open from one goes nowhere. Each part
// of the app answers the methods of shared/pages-api.ts that are its own.

import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
  webContents,
} from "electron";
import { PAGES_CHANGED, PAGES_CHANNEL, type PagesApi } from "@/shared/pages-api";

/** The pages API as the main process answers it: the same methods, the asking frame's web contents first. */
export type PageHandlers = {
  [K in keyof PagesApi]: (sender: WebContents, ...args: Parameters<PagesApi[K]>) => unknown;
};

export class AppPages {
  /**
   * `pagesUrl` is the file URL of the folder holding the bundled pages;
   * `preload` the pages' preload (src/preload/pages.ts), as a file path.
   */
  constructor(
    readonly pagesUrl: string,
    readonly preload: string,
  ) {}

  /** Answers these methods of the pages API. The arguments come from a page: each handler checks their types. */
  answer(handlers: Partial<Omit<PageHandlers, "onChanged">>) {
    for (const [name, handle] of Object.entries(handlers)) {
      ipcMain.handle(PAGES_CHANNEL + name, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!event.senderFrame?.url.startsWith(this.pagesUrl)) throw new Error("not an app page");
        return (handle as (sender: WebContents, ...rest: unknown[]) => unknown)(event.sender, ...args);
      });
    }
  }

  /** Tells every open page of the app that what it shows may have changed. */
  changed() {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.getURL().startsWith(this.pagesUrl)) contents.send(PAGES_CHANGED);
    }
  }

  /** The address of a bundled page (`page` is its file name, with any query). */
  url(page: string): string {
    return new URL(page, this.pagesUrl).href;
  }

  /** A window showing the bundled page `page`; `options` set its size and kind, never its web preferences. */
  window(page: string, options: BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({
      // pages.css's --bg, so the window is not white until its page paints.
      backgroundColor: "#1b1d22",
      ...options,
      webPreferences: this.preferences(),
    });
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void win.loadURL(this.url(page));
    return win;
  }

  /** The web preferences of anything showing a bundled page. */
  preferences() {
    return { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false };
  }
}

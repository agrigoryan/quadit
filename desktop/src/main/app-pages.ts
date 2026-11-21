// The app's own bundled pages (src/pages): the windows and views that show
// them, held to one set of rules, and the IPC that answers them. Only frames
// loaded from the app's own page files are answered, and these pages never
// leave their file: a navigation or window.open from one goes nowhere. They
// run in the app's default session, never a server's partition. Each part
// of the app answers the methods of shared/pages-api.ts that are its own.

import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
  WebContentsView,
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
    this.keepHome(win.webContents);
    void win.loadURL(this.url(page));
    return win;
  }

  /**
   * A view showing the bundled page `page`, to lay over a window (the first
   * run's, over a server window: server-windows.ts, cover). It is transparent
   * until its page paints, and wherever the page leaves it so.
   */
  view(page: string): WebContentsView {
    const view = new WebContentsView({ webPreferences: this.preferences() });
    view.setBackgroundColor("#00000000");
    this.keepHome(view.webContents);
    void view.webContents.loadURL(this.url(page));
    return view;
  }

  /** Keeps a bundled page where it is: it navigates nowhere and opens nothing. */
  private keepHome(contents: WebContents) {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  /** The web preferences of anything showing a bundled page. */
  preferences() {
    return { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false };
  }
}

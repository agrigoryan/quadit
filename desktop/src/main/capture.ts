// Quick capture: a small window, toggled by a global key from anywhere,
// that makes a task or a page in one of the workspaces the app's windows
// show. The workspace's own page makes it (a "capture" request); the app
// remembers where the last one went and offers it again.

import { type BrowserWindow, globalShortcut } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Requests } from "@/main/requests";
import type { Settings } from "@/main/setup-settings";
import type { DesktopOutcome } from "@/shared/bridge";

/** The quick-capture key: fixed, on or off in setup. */
export const CAPTURE_SHORTCUT = "Alt+CommandOrControl+N";
const TITLE_MAX = 500;
const BODY_MAX = 100_000;

export class Capture {
  private win: BrowserWindow | undefined;
  private shortcutError: string | undefined;

  constructor(
    private pages: AppPages,
    private settings: Settings,
    requests: Requests,
  ) {
    pages.answer({
      lastCapture: () => settings.get().lastCapture,
      capture: (_sender, raw): Promise<DesktopOutcome> => {
        const c = captureOf(raw);
        if (typeof c === "string") return Promise.resolve({ ok: false, message: c });
        const { serverId, workspaceId, project, what, title, body } = c;
        settings.change({ lastCapture: { serverId, workspaceId, project, what } });
        return requests.toWorkspace(serverId, workspaceId, { kind: "capture", project, what, title, body });
      },
    });
  }

  /** Takes the global key when its setting is on and lets it go when off; remembers why it could not be taken. */
  applyShortcut() {
    globalShortcut.unregister(CAPTURE_SHORTCUT);
    this.shortcutError = undefined;
    if (!this.settings.get().captureShortcut) return;
    if (!globalShortcut.register(CAPTURE_SHORTCUT, () => this.toggle())) {
      this.shortcutError =
        "Another app has this key already. Quit that app, or turn the key off and use File → Quick Capture.";
    }
  }

  shortcut(): { accelerator: string; error?: string } {
    return { accelerator: CAPTURE_SHORTCUT, ...(this.shortcutError ? { error: this.shortcutError } : {}) };
  }

  /** Shows the capture window in front, or hides it when it already is. */
  toggle() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isVisible() && this.win.isFocused()) this.win.hide();
      else {
        this.win.show();
        this.win.focus();
      }
      return;
    }
    this.win = this.pages.window("capture.html", {
      name: "capture",
      width: 480,
      height: 420,
      resizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: "Quick Capture",
    });
    this.win.on("closed", () => (this.win = undefined));
  }
}

type Captured = {
  serverId: string;
  workspaceId: string;
  project: string | null;
  what: "task" | "page";
  title: string;
  body: string;
};

/** What the capture page sent, checked; or what is wrong with it, to show. */
function captureOf(raw: unknown): Captured | string {
  const { serverId, workspaceId, project, what, title, body } = (raw ?? {}) as Record<string, unknown>;
  if (typeof serverId !== "string" || typeof workspaceId !== "string") return "Pick a workspace.";
  if (what !== "task" && what !== "page") return "Pick a task or a page.";
  if (project !== null && typeof project !== "string") return "Pick a project.";
  if (what === "task" && project === null) return "A task needs a project.";
  if (typeof title !== "string" || title.trim() === "") return "Give it a title.";
  if (title.length > TITLE_MAX) return `A title is at most ${TITLE_MAX} characters.`;
  if (typeof body !== "string" || body.length > BODY_MAX) return `The text is at most ${BODY_MAX} characters.`;
  return { serverId, workspaceId, project, what, title: title.trim(), body };
}

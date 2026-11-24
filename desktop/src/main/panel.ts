// The menu-bar panel: a small frameless window under the tray icon, as tall
// as what it shows (up to a most, past which it scrolls), listing for each
// workspace a server's window shows what waits on the person (questions
// with their buttons, tasks that wait on them, runs that need them), the
// runs open now with Stop, and the agents with the first line of their
// card; then New task and Open Quadit. It hides as soon as it loses focus.
// A button goes to the workspace's own page as a request (Requests.act);
// only workspaces some window shows are listed.

import { type BrowserWindow, type Rectangle, screen } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Requests } from "@/main/requests";

const WIDTH = 380;
/** The panel's height before its page has said, and its least and most. */
const FIRST_HEIGHT = 240;
const LEAST_HEIGHT = 120;
const MOST_HEIGHT = 620;
const JUST_HIDDEN_MS = 300;

export interface PanelParts {
  /** Opens quick capture (capture.ts). */
  openCapture(): void;
  /** Opens Connect agents over the server's window at one agent, for connecting it when asked. */
  openAgent(serverId: string, agent: string, intent: "connect" | null): void;
}

export class Panel {
  private win: BrowserWindow | undefined;
  /** When the panel last hid: a click on the tray icon takes the focus first, and must not open it again at once. */
  private hiddenAt = 0;
  /** Where the tray icon was when the panel was last shown, for placing it again when its height changes. */
  private tray: Rectangle | null = null;
  private height = FIRST_HEIGHT;

  constructor(
    private pages: AppPages,
    requests: Requests,
    parts: PanelParts,
  ) {
    pages.answer({
      act: (_sender, serverId, workspaceId, action) => {
        const { request, text } = (action ?? {}) as Record<string, unknown>;
        return requests.act(String(serverId), String(workspaceId), {
          request: String(request),
          ...(typeof text === "string" ? { text } : {}),
        });
      },
      fitPanel: (_sender, height) => this.fit(Number(height)),
      openCapture: () => {
        this.win?.hide();
        parts.openCapture();
      },
      openAgent: (_sender, serverId, agent, intent) => {
        this.win?.hide();
        parts.openAgent(String(serverId), String(agent), intent === "connect" ? "connect" : null);
      },
    });
  }

  /** Shows the panel under the tray icon at `tray` (or at the top right of the screen when it has no place), or hides it. */
  toggle(tray: Rectangle | null) {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide();
      return;
    }
    if (Date.now() - this.hiddenAt < JUST_HIDDEN_MS) return;
    this.tray = tray;
    const win = this.window();
    win.setPosition(...placeUnder(tray, this.height));
    win.show();
    win.focus();
  }

  /** Sizes the panel to `height`, its page's, within its least and most, kept under the icon. */
  private fit(height: number) {
    if (!Number.isFinite(height)) return;
    this.height = Math.min(Math.max(Math.ceil(height), LEAST_HEIGHT), MOST_HEIGHT);
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.setSize(WIDTH, this.height);
    if (win.isVisible()) win.setPosition(...placeUnder(this.tray, this.height));
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = this.pages.window("panel.html", {
      name: "panel",
      width: WIDTH,
      height: this.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Quadit",
    });
    win.on("blur", () => {
      this.hiddenAt = Date.now();
      win.hide();
    });
    win.on("closed", () => (this.win = undefined));
    this.win = win;
    return win;
  }
}

/** Where the panel's top left goes: centred under the tray icon (over it when the bar is at the bottom), on screen. */
function placeUnder(tray: Rectangle | null, height: number): [number, number] {
  const known = tray && tray.width > 0 ? tray : null;
  const area = (known ? screen.getDisplayMatching(known) : screen.getPrimaryDisplay()).workArea;
  if (!known) return [area.x + area.width - WIDTH - 8, area.y + 8];
  const x = Math.round(known.x + known.width / 2 - WIDTH / 2);
  const below = known.y < area.y + area.height / 2;
  const y = below ? known.y + known.height + 4 : known.y - height - 4;
  return [
    Math.min(Math.max(x, area.x + 8), area.x + area.width - WIDTH - 8),
    Math.min(Math.max(y, area.y), area.y + area.height - height),
  ];
}

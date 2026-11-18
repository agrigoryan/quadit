// The menu-bar panel: a small frameless window under the tray icon listing,
// for each workspace a server's window shows, the decisions waiting on the
// person with their buttons, and the agents with what they are doing. It
// hides as soon as it loses focus. A button goes to the workspace's own page
// as a request (Requests.act); only workspaces some window shows are listed.

import { type BrowserWindow, type Rectangle, screen } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Requests } from "@/main/requests";

const WIDTH = 380;
const HEIGHT = 520;
const JUST_HIDDEN_MS = 300;

export class Panel {
  private win: BrowserWindow | undefined;
  /** When the panel last hid: a click on the tray icon takes the focus first, and must not open it again at once. */
  private hiddenAt = 0;

  constructor(
    private pages: AppPages,
    requests: Requests,
  ) {
    pages.answer({
      act: (_sender, serverId, workspaceId, action) => {
        const { request, text } = (action ?? {}) as Record<string, unknown>;
        return requests.act(String(serverId), String(workspaceId), {
          request: String(request),
          ...(typeof text === "string" ? { text } : {}),
        });
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
    const win = this.window();
    win.setPosition(...placeUnder(tray));
    win.show();
    win.focus();
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = this.pages.window("panel.html", {
      name: "panel",
      width: WIDTH,
      height: HEIGHT,
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
function placeUnder(tray: Rectangle | null): [number, number] {
  const known = tray && tray.width > 0 ? tray : null;
  const area = (known ? screen.getDisplayMatching(known) : screen.getPrimaryDisplay()).workArea;
  if (!known) return [area.x + area.width - WIDTH - 8, area.y + 8];
  const x = Math.round(known.x + known.width / 2 - WIDTH / 2);
  const below = known.y < area.y + area.height / 2;
  const y = below ? known.y + known.height + 4 : known.y - HEIGHT - 4;
  return [
    Math.min(Math.max(x, area.x + 8), area.x + area.width - WIDTH - 8),
    Math.min(Math.max(y, area.y), area.y + area.height - HEIGHT),
  ];
}

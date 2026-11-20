// How a server's window is framed (desktop contract §9). On macOS, a server
// whose pages say they are laid out for it (its version answer's
// desktop.inset, kept on its record) gets a window without a title bar: the
// page fills the window to its top edge and the three window buttons float
// over its top left corner, centred in a strip as tall as the web app's top
// bar. The page learns where the buttons are from the Window Controls
// Overlay, which titleBarOverlay turns on; the app's own views over the
// window keep clear of the strip or carry it (server-windows.ts,
// connection-error.html). Windows and Linux keep their frames, and so does a
// server whose pages would sit under the buttons with nothing to drag the
// window by.
//
// The choice is made when the window is made: a server that starts speaking
// it later gets it the next time its window is made.

import type { BrowserWindowConstructorOptions } from "electron";
import type { Server } from "@/main/servers";

/** The strip's height: the web app's top bar's (its h-11), so the bar and the sidebar's strip line up with it. */
export const STRIP_HEIGHT = 44;

// Electron (checked in its v45 source, window_buttons_proxy.mm) makes the
// title area the three buttons with trafficLightPosition as a margin on every
// side: as tall as the buttons and twice the margin's y, and starting, for
// the page, twice the margin's x past the buttons' width. So the margin's y
// centres the buttons in the strip. The buttons' height is macOS's, not
// measured on a real window yet: the macOS end-to-end spec (window-frame.spec.ts)
// logs the rect the page is given, to tune these from.
const BUTTON_HEIGHT = 16;
const BUTTONS_LEFT = 16;

export interface Frame {
  options: Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition">;
  /** The height of the strip at the window's top that the buttons sit in and the window is dragged by; 0 with a title bar. */
  strip: number;
}

/** The frame of a server's window on `platform`, for a server whose record says what its pages are laid out for. */
export function frameFor(platform: NodeJS.Platform, server: Pick<Server, "inset">): Frame {
  if (platform !== "darwin" || server.inset < 1) return { options: {}, strip: 0 };
  return {
    options: {
      titleBarStyle: "hiddenInset",
      titleBarOverlay: true,
      trafficLightPosition: { x: BUTTONS_LEFT, y: (STRIP_HEIGHT - BUTTON_HEIGHT) / 2 },
    },
    strip: STRIP_HEIGHT,
  };
}

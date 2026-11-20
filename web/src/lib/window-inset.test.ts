// @vitest-environment jsdom
// Where the page learns it is in a window without a title bar (lib/window-inset.ts):
// the window's controls overlay, as the Quadit app on macOS gives it.

import { afterEach, describe, expect, it } from "vitest";
import { followWindowInset } from "@/lib/window-inset";

/** The overlay a window gives its page: visible over a title area, or not; it says when that changes. */
class Overlay extends EventTarget {
  visible = false;
  rect = new DOMRect(0, 0, 0, 0);
  getTitlebarAreaRect() {
    return this.rect;
  }
  /** The window moved its buttons, hid them or showed them. */
  change(visible: boolean, rect: DOMRect) {
    this.visible = visible;
    this.rect = rect;
    this.dispatchEvent(new Event("geometrychange"));
  }
}

function inWindow(overlay: Overlay | undefined) {
  Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay, configurable: true });
}

const html = document.documentElement;
const inset = () => ({
  marked: html.hasAttribute("data-window-inset"),
  left: html.style.getPropertyValue("--window-inset-left"),
  height: html.style.getPropertyValue("--window-inset-height"),
});
const NONE = { marked: false, left: "", height: "" };

let stop = () => {};
afterEach(() => {
  stop();
  inWindow(undefined);
});

describe("followWindowInset", () => {
  it("marks the page and says where the title area is while the overlay is visible", () => {
    const overlay = new Overlay();
    overlay.visible = true;
    overlay.rect = new DOMRect(86, 0, 1194, 44);
    inWindow(overlay);
    stop = followWindowInset();
    expect(inset()).toEqual({ marked: true, left: "86px", height: "44px" });
  });

  it("leaves the page as it is where there is no overlay, or it is not visible", () => {
    inWindow(undefined);
    stop = followWindowInset();
    expect(inset()).toEqual(NONE);
    stop();

    inWindow(new Overlay());
    stop = followWindowInset();
    expect(inset()).toEqual(NONE);
  });

  it("follows the overlay as it moves, hides (full screen) and comes back", () => {
    const overlay = new Overlay();
    inWindow(overlay);
    stop = followWindowInset();
    overlay.change(true, new DOMRect(86, 0, 1194, 44));
    expect(inset()).toEqual({ marked: true, left: "86px", height: "44px" });
    overlay.change(true, new DOMRect(90, 0, 1190, 46));
    expect(inset()).toEqual({ marked: true, left: "90px", height: "46px" });
    // Full screen: macOS hides the buttons and Electron gives an empty title area.
    overlay.change(true, new DOMRect(0, 0, 0, 0));
    expect(inset()).toEqual(NONE);
    overlay.change(false, new DOMRect(0, 0, 0, 0));
    expect(inset()).toEqual(NONE);
    overlay.change(true, new DOMRect(86, 0, 1194, 44));
    expect(inset()).toEqual({ marked: true, left: "86px", height: "44px" });
  });

  it("stops following when told, leaving the page unmarked", () => {
    const overlay = new Overlay();
    overlay.visible = true;
    overlay.rect = new DOMRect(86, 0, 1194, 44);
    inWindow(overlay);
    followWindowInset()();
    expect(inset()).toEqual(NONE);
    overlay.change(true, new DOMRect(90, 0, 1190, 46));
    expect(inset()).toEqual(NONE);
  });
});

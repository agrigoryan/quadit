// The window without a title bar (the desktop contract, §9). In the Quadit
// app on macOS a server's window has no title bar: the page fills the window
// to its top edge and the window's three buttons float over its top left
// corner. The page learns this from the standard Window Controls Overlay,
// never from the user agent or the app's bridge. While the overlay is
// visible, <html> carries data-window-inset and two lengths:
//
//   --window-inset-left    where the title area left free of the buttons starts
//   --window-inset-height  the title area's height: the strip the window is dragged by
//
// Everything laid out for such a window hangs off that attribute (the
// window-inset: variant and the drag rules in styles/index.css), so in a
// browser, a framed window, or full screen, where macOS hides the buttons,
// nothing changes.

/** The Window Controls Overlay API, which TypeScript's DOM types do not have yet. */
interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

/** Keeps <html> marked as the window's overlay says, from now on; gives the function that stops and unmarks it. */
export function followWindowInset(): () => void {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return () => {};
  const html = document.documentElement;
  const unmark = () => {
    html.removeAttribute("data-window-inset");
    html.style.removeProperty("--window-inset-left");
    html.style.removeProperty("--window-inset-height");
  };
  const follow = () => {
    const area = overlay.getTitlebarAreaRect();
    // Full screen hands an empty title area (Electron's GetWindowControlsOverlayRect), whatever it says of visible.
    if (!overlay.visible || area.width === 0 || area.height === 0) return unmark();
    html.setAttribute("data-window-inset", "");
    html.style.setProperty("--window-inset-left", `${area.x}px`);
    html.style.setProperty("--window-inset-height", `${area.height}px`);
  };
  follow();
  overlay.addEventListener("geometrychange", follow);
  return () => {
    overlay.removeEventListener("geometrychange", follow);
    unmark();
  };
}

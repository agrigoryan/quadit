/**
 * In a window without a title bar (lib/window-inset.ts), the strip across the top that the window is dragged by, over
 * a page with no bar of its own (sign-in, set-up, errors); a page with one hides it (styles/index.css). Nothing in a
 * browser.
 */
export function WindowStrip() {
  return (
    <div
      data-window-bar
      data-window-strip
      className="fixed inset-x-0 top-0 hidden h-(--window-inset-height) window-inset:block"
    />
  );
}

// Input held back for a moment on Connect agents opened by a server's page
// (src/main/connect-page.ts): its first 700 ms on screen take no pointer or
// keyboard input, so that a click the page timed for itself, meant by the
// person for that page, lands on nothing rather than on a card's one-click
// Connect. A delay of this kind is the usual guard against a page making a
// click land on something that appears under it. The page's HTML starts the
// element inert; this lets input in.

/** How long input is held: longer than a click already on its way, short enough not to be in the way. */
export const HOLD_MS = 700;

/** Lets `element` take input: at once on a page the person opened, HOLD_MS from now on one a server's page opened. */
export function letInputIn(element: { inert: boolean }, openedByPage: boolean) {
  if (!openedByPage) {
    element.inert = false;
    return;
  }
  setTimeout(() => (element.inert = false), HOLD_MS);
}

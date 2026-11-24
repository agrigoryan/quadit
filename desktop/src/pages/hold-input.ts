// Input held back for a moment on Connect agents opened by another server's
// page (src/main/connect-page.ts): its first 700 ms on screen take no pointer or
// keyboard input, so that a click the page timed for itself, meant by the
// person for that page, lands on nothing rather than on a card's one-click
// Connect. A delay of this kind is the usual guard against a page making a
// click land on something that appears under it. The page's HTML starts the
// element inert; this lets input in. Asked again (that page's later
// publication changed what Connect agents shows), it holds input again for
// as long, from then.

/** How long input is held: longer than a click already on its way, short enough not to be in the way. */
export const HOLD_MS = 700;

/** The end of each element's hold under way: a later hold replaces it. */
const holds = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** Lets `element` take input: at once on a page the person opened, HOLD_MS from now on one a server's page opened. */
export function letInputIn(element: { inert: boolean }, openedByPage: boolean) {
  clearTimeout(holds.get(element));
  if (!openedByPage) {
    element.inert = false;
    return;
  }
  element.inert = true;
  holds.set(
    element,
    setTimeout(() => (element.inert = false), HOLD_MS),
  );
}

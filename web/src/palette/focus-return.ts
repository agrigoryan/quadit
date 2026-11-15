// Where the keyboard goes when the palette or the shortcuts sheet closes.
// Each puts the focus inside itself as it opens (the palette's box, the
// sheet's list) before the dialog notes what had it, so the dialog would
// give it back to an element that is gone, and the browser leaves it on
// <body>: Tab then starts from the top of the document. So what had the
// focus is noted here, before either opens, and given it back after.

import { useEffect, useState } from "react";
import { focusPage } from "@/shell/page-focus";

/**
 * Gives the focus back to what had it when open turned true, or to the page
 * if that is gone, once open turns false or the caller goes away (the
 * palette is there only while it is open).
 */
export function useFocusReturn(open: boolean) {
  const [before, setBefore] = useState<Element | null>(() => (open ? document.activeElement : null));
  const [wasOpen, setWasOpen] = useState(open);
  // Noted while rendering the opening, before anything inside takes the focus.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setBefore(document.activeElement);
  }

  useEffect(() => {
    if (!open) return;
    // After the dialog has given the focus back as it can.
    return () => void window.setTimeout(() => giveBack(before));
  }, [open, before]);
}

/** Puts the focus on had, or on the page, when nothing has it now. */
function giveBack(had: Element | null) {
  const now = document.activeElement;
  if (now && now !== document.body) return; // somewhere already: a command ran, or the dialog managed
  if (had instanceof HTMLElement && had !== document.body && had.isConnected) had.focus({ preventScroll: true });
  else focusPage();
}

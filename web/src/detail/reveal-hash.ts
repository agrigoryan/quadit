// A task opened at one of its questions: /games/task/SVA-12#decision-<id>.
// A click on such a link inside the app scrolls there itself; this does the
// same for an address that was typed, pasted or reloaded, and marks the
// question for a moment so the eye finds it.

import { useEffect } from "react";
import { revealDecision } from "@/insights/decisions/reveal";

const PATTERN = /^#decision-([0-9a-f-]{8,})$/i;

/** Lights the question up briefly. It is found by its id inside the task panel. */
function highlight(decisionId: string, tries = 40) {
  const el = document.getElementById(`decision-${decisionId}`);
  if (!el?.closest("[data-task-panel]")) {
    if (tries > 0) setTimeout(() => highlight(decisionId, tries - 1), 100);
    return;
  }
  el.animate([{ backgroundColor: "var(--move-soft)" }, { backgroundColor: "var(--move-soft)", offset: 0.6 }, { backgroundColor: "transparent" }], {
    duration: 2200,
    easing: "ease-out",
  });
}

/**
 * Scrolls the open task panel to the question named in the address, when
 * the panel opens and whenever the address names another. `ready` is false
 * until the task is known, so the search starts when there is a panel body.
 */
export function useRevealFromHash(ready: boolean) {
  // The browser's own address: the router's may be the page under the panel.
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  useEffect(() => {
    const id = PATTERN.exec(hash)?.[1];
    if (!ready || !id) return;
    revealDecision(id);
    highlight(id);
  }, [ready, hash]);
}

// Cmd/Ctrl-Enter sends a form from whichever of its fields has the cursor: a
// new task or several, a question asked or edited, the note before an answer,
// a preference, a comment, an epic's description, a formula.

import type { KeyboardEvent } from "react";

/**
 * For a keydown handler: runs `send` on Cmd/Ctrl-Enter, and keeps that Enter
 * from typing a new line. True when it did, so the handler can stop there.
 */
export function sendOnModEnter(e: KeyboardEvent, send: () => unknown): boolean {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return false;
  e.preventDefault();
  // A send that talks to the server reports its own outcome in the dialog.
  void send();
  return true;
}

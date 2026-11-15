// Cmd/Ctrl-Enter sends a question's dialog from whichever of its fields has
// the cursor: the new question, the edit of one, the note before an answer.

import type { KeyboardEvent } from "react";

/** For a keydown handler: runs `send` on Cmd/Ctrl-Enter, and keeps that Enter from typing a new line. */
export function sendOnModEnter(e: KeyboardEvent, send: () => unknown) {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  // A send that talks to the server reports its own outcome in the dialog.
  void send();
}

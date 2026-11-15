// Where the caret goes when a text box of the task panel takes the focus.

import type { FocusEvent } from "react";

/** Editing starts where the text ends, not before its first letter. */
export function caretToEnd(e: FocusEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget;
  if (el.selectionStart === 0 && el.selectionEnd === 0) el.setSelectionRange(el.value.length, el.value.length);
}

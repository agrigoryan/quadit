// Small things several parts of the task panel share.

import type { FocusEvent } from "react";

/** A small "x" that shows when its row is hovered or focused; always there on touch screens. */
export const rowAction =
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100";

/** Editing starts where the text ends, not before its first letter. */
export function caretToEnd(e: FocusEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget;
  if (el.selectionStart === 0 && el.selectionEnd === 0) el.setSelectionRange(el.value.length, el.value.length);
}

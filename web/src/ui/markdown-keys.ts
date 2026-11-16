// The keys that help write Markdown in a plain text box (a task's
// description, a comment, a decision's thread, an epic's description):
// Cmd+B and Cmd+I put ** ** and _ _ around the selection, or take them off;
// Enter on a list item ("- ", "* ", "1. ", "- [ ] ") starts the next one,
// and on an empty item ends the list. Each edit is typed in through the
// browser (execCommand insertText), so the box's own undo takes it back.

import type { KeyboardEvent } from "react";
import { combo, MOD } from "@/hooks/hotkeys";

/** A list item's start: its indent, its bullet or number, the space after, and a task box. */
const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;

/**
 * For a text box's keydown handler: does what the key means in Markdown,
 * and answers true when it did (the key's own action is then kept from
 * happening).
 */
export function markdownKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.nativeEvent.isComposing) return false;
  const box = e.currentTarget;
  const key = combo(e.nativeEvent);
  // The command key on a Mac, where Ctrl+B and Ctrl+I move the caret; Ctrl elsewhere.
  const own = MOD === "⌘" ? e.metaKey && !e.ctrlKey : e.ctrlKey;
  const done =
    key === "mod+b" && own
      ? wrap(box, "**")
      : key === "mod+i" && own
        ? wrap(box, "_")
        : key === "Enter" && continueList(box);
  if (done) e.preventDefault();
  return done;
}

/** Puts `mark` around the selection, or takes it off one it is around or at both ends of. */
function wrap(box: HTMLTextAreaElement, mark: string): true {
  const { value, selectionStart: start, selectionEnd: end } = box;
  const n = mark.length;
  const text = value.slice(start, end);
  if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark) {
    type(box, start - n, end + n, text);
    box.setSelectionRange(start - n, end - n);
  } else if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
    type(box, start, end, text.slice(n, -n));
    box.setSelectionRange(start, end - 2 * n);
  } else {
    type(box, start, end, mark + text + mark);
    box.setSelectionRange(start + n, end + n);
  }
  return true;
}

/** Enter on a list item: the next item, or the end of the list on an empty one. False anywhere else. */
function continueList(box: HTMLTextAreaElement): boolean {
  const { value, selectionStart: caret, selectionEnd } = box;
  if (caret !== selectionEnd) return false;
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const found = ITEM.exec(value.slice(lineStart, caret));
  if (!found) return false;
  const [marker, indent = "", bullet = "", space = "", task] = found;
  const lineEnd = value.indexOf("\n", caret);
  const end = lineEnd < 0 ? value.length : lineEnd;
  if (value.slice(lineStart + marker.length, end).trim() === "") {
    type(box, lineStart, end, "");
    return true;
  }
  const number = /^\d+/.exec(bullet)?.[0];
  const next = number ? `${Number(number) + 1}${bullet.slice(number.length)}` : bullet;
  type(box, caret, caret, `\n${indent}${next}${space}${task ? "[ ] " : ""}`);
  return true;
}

/**
 * Replaces the text from `start` to `end` as if typed, the caret after it.
 * Where the browser cannot type it in (a test's), the text is set and the
 * box told, as typing would.
 */
function type(box: HTMLTextAreaElement, start: number, end: number, text: string) {
  box.setSelectionRange(start, end);
  const typed =
    typeof document.execCommand === "function" &&
    (text ? document.execCommand("insertText", false, text) : document.execCommand("delete"));
  if (typed) return;
  box.setRangeText(text, start, end, "end");
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

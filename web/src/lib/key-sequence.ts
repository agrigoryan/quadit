// Two keys in a row: "g" then "i". The first key arms the sequence for a
// moment; the second, if it comes in time, runs it and goes no further, so
// "g" then "a" goes to a page and does not also open the assignee picker.
// Like the single keys, a sequence rests while a field has the focus or a
// dialog or menu is open.

import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";
import { isTyping, overlayOpen } from "@/lib/hotkeys";

/** How long the first key waits for the second. */
export const SEQUENCE_MS = 1500;

/** What each first key leads to: the key that follows, and what it runs. */
export type Sequences = Record<string, Record<string, () => void>>;

/** The first key of a sequence now waiting for its second; the hint on screen reads it. */
export const usePendingKey = create<{ prefix: string | null }>(() => ({ prefix: null }));

/** Keys held on the way to another key: they neither continue nor end a sequence. */
const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "CapsLock"];

let timer: ReturnType<typeof setTimeout> | undefined;

function disarm() {
  clearTimeout(timer);
  if (usePendingKey.getState().prefix !== null) usePendingKey.setState({ prefix: null });
}

function arm(prefix: string) {
  clearTimeout(timer);
  usePendingKey.setState({ prefix });
  timer = setTimeout(disarm, SEQUENCE_MS);
}

const keyOf = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
const withModifier = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey;
const elsewhere = (e: KeyboardEvent) => isTyping(e.target) || overlayOpen();

/** Listens for the sequences given. Mount it once, in the frame of the app. */
export function useKeySequences(sequences: Sequences, enabled = true) {
  // The sequences as of the last render, read when a key is pressed.
  const latest = useEffectEvent(() => sequences);

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || MODIFIERS.includes(e.key)) return;
      const pending = usePendingKey.getState().prefix;
      const key = keyOf(e);
      if (pending === null) {
        const starts = key in latest() && !e.repeat && !e.shiftKey && !withModifier(e) && !e.defaultPrevented;
        if (starts && !elsewhere(e)) arm(key);
        return;
      }
      disarm();
      // A combination, or a key for a field or a menu that opened meanwhile, is not the second key.
      if (withModifier(e) || elsewhere(e)) return;
      // Any other key ends the sequence and is used up by it, also one that leads nowhere (Esc to back out).
      e.preventDefault();
      e.stopPropagation();
      latest()[pending]?.[key]?.();
    }
    // Before every other listener, so that the second key reaches nothing else.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", disarm, true);
    window.addEventListener("blur", disarm);
    return () => {
      disarm();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", disarm, true);
      window.removeEventListener("blur", disarm);
    };
  }, [enabled]);
}

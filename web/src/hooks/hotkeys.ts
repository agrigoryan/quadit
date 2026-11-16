// Single-key shortcuts ("j", "c", "?") and combinations ("mod+k",
// "mod+shift+z"); combo() says what each key press is called. A key typed
// into a field, or while a dialog or menu is open, is left alone.
// Two keys in a row ("g" then "i") are in hooks/key-sequence.ts.
//
// The hooks folder: React hooks any part of the app may use, that know
// nothing of the server's data, the router or any one screen: the keyboard
// (this file, key-sequence.ts), the minute clock (tick.ts), a media query
// (use-media.ts), a flag that waits before it shows (use-delayed-flag.ts).

import { useEffect, useEffectEvent } from "react";

type Handler = (event: KeyboardEvent) => void;
export type Hotkeys = Record<string, Handler>;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier shown in hints: the command key on a Mac, Ctrl elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl";

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * True while a dialog, menu or picker is open above the page. One that has
 * closed but is still on the page, playing its way out (Radix marks it
 * data-state="closed"), does not count: a key pressed just after Escape works.
 */
export function overlayOpen(): boolean {
  return (
    document.querySelector(
      ':is([role="dialog"], [role="menu"], [role="listbox"], [data-overlay]):not([data-state="closed"])',
    ) !== null
  );
}

/** The signs on the US keyboard, by the key they are on: a chord with Cmd or Ctrl names the key, as letters do. */
const SIGN_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/**
 * What a key press is called in a Hotkeys table: "j", "shift+s",
 * "mod+shift+z", "alt+u", "?", "mod+.", "Enter", "shift+ ".
 *
 * A letter is named by the key pressed (e.code), not by the character it
 * types, so the keys work under any keyboard layout (Russian, Armenian…),
 * and Option with a letter on a Mac is "alt+" that letter, not "¨" or "ø".
 * So is a digit, unless Option makes it type a sign (the German Mac's [ is
 * Option+5). Shift is in the name, taken from the Shift key itself: Caps
 * Lock does not turn S into Shift+S, and a bare "s" does not run on Shift+S.
 * Cmd and Ctrl are both "mod". A sign typed as a character ("?", "[", "/")
 * is named by that character, the Shift or Option it took included in it;
 * held with Cmd or Ctrl it is named by its key, Shift apart ("mod+shift+,").
 * Any other key (Enter, Escape, Space, the arrows) is named by its name, with
 * Shift. An event that carries no key code is named by its character.
 */
export function combo(e: KeyboardEvent): string {
  const mod = e.metaKey || e.ctrlKey;
  const letter = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(e.code) && !(e.altKey && !mod)
      ? e.code.slice(5)
      : mod && SIGN_KEYS[e.code]
        ? SIGN_KEYS[e.code]
        : !e.code && /^[a-z0-9]$/i.test(e.key)
          ? e.key.toLowerCase()
          : undefined;
  // A character typed, Shift and Option already in it.
  if (letter === undefined && e.key.length === 1 && e.key !== " " && !mod) return e.key;
  const key = letter ?? e.key;
  return (mod ? "mod+" : "") + (e.altKey ? "alt+" : "") + (e.shiftKey ? "shift+" : "") + key;
}

/** True while the task panel covers the page. It carries the data-task-panel attribute. */
const panelOpen = () => document.querySelector("[data-task-panel]") !== null;

interface Options {
  enabled?: boolean;
  /** Also fire while an overlay is open or a field has focus (for the overlay's own keys). */
  always?: boolean;
  /**
   * Hold combinations with Cmd or Ctrl to the rules of bare keys: not in a
   * field, not under an overlay, and on the page layer not under the panel.
   * Left out, they work everywhere (Cmd+K opens the palette from a field).
   */
  guardChords?: boolean;
  /**
   * Whose keys these are. "page" keys (the default) rest while the task
   * panel is open, so J/K under the panel do nothing; the panel's own keys
   * use "panel"; keys that work everywhere use "global".
   */
  layer?: "page" | "panel" | "global";
}

export function useHotkeys(
  keys: Hotkeys,
  { enabled = true, always = false, guardChords = false, layer = "page" }: Options = {},
) {
  // The keys as of the last render, read when a key is pressed.
  const handlerFor = useEffectEvent((name: string): Handler | undefined => keys[name]);

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const name = combo(e);
      const handler = handlerFor(name);
      if (!handler) return;
      // Combinations with the command key work everywhere, unless asked otherwise; bare keys do not.
      const bare = guardChords || !name.startsWith("mod+");
      if (!always && bare && (isTyping(e.target) || overlayOpen())) return;
      if (bare && layer === "page" && panelOpen()) return;
      handler(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, always, guardChords, layer]);
}

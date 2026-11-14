// Single-key shortcuts ("j", "c", "?") and combinations ("mod+k"). A key
// typed into a field, or while a dialog or menu is open, is left alone.

import { useEffect, useRef } from "react";

type Handler = (event: KeyboardEvent) => void;
export type Hotkeys = Record<string, Handler>;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier shown in hints: the command key on a Mac, Ctrl elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** True while a dialog, menu or picker is open above the page. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-overlay]') !== null;
}

function combo(e: KeyboardEvent): string {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (e.metaKey || e.ctrlKey ? "mod+" : "") + (e.altKey ? "alt+" : "") + key;
}

/** True while the task panel covers the page. It carries the data-task-panel attribute. */
const panelOpen = () => document.querySelector("[data-task-panel]") !== null;

interface Options {
  enabled?: boolean;
  /** Also fire while an overlay is open or a field has focus (for the overlay's own keys). */
  always?: boolean;
  /**
   * Whose keys these are. "page" keys (the default) rest while the task
   * panel is open, so J/K under the panel do nothing; the panel's own keys
   * use "panel"; keys that work everywhere use "global".
   */
  layer?: "page" | "panel" | "global";
}

export function useHotkeys(keys: Hotkeys, { enabled = true, always = false, layer = "page" }: Options = {}) {
  const latest = useRef(keys);
  latest.current = keys;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const name = combo(e);
      const handler = latest.current[name];
      if (!handler) return;
      // Combinations with the command key work everywhere; bare keys do not.
      const bare = !name.startsWith("mod+");
      if (!always && bare && (isTyping(e.target) || overlayOpen())) return;
      if (bare && layer === "page" && panelOpen()) return;
      handler(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, always, layer]);
}

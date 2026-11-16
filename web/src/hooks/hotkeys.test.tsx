// @vitest-environment jsdom
// Single-key shortcuts (hooks/hotkeys.ts): what a key press is called, and
// when a key rests (an overlay open, a field being typed in).

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { combo, type Hotkeys, useHotkeys } from "@/hooks/hotkeys";

interface KeysProps {
  keys: Hotkeys;
  overlay?: "open" | "closed";
  /** The overlay is a panel beside the page, which leaves the page's keys working. */
  beside?: boolean;
  guardChords?: boolean;
}

function Keys({ keys, overlay, beside, guardChords }: KeysProps) {
  useHotkeys(keys, { guardChords });
  // Radix keeps an overlay on the page, marked closed, while it plays its way out.
  return (
    <>
      <input aria-label="field" />
      {overlay && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- stands in for Radix's overlay, which is a div with the role
        <div role="dialog" aria-label="overlay" data-state={overlay} data-beside={beside || undefined} />
      )}
    </>
  );
}

const press = (key: string, more: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...more });
const named = (init: KeyboardEventInit) => combo(new KeyboardEvent("keydown", init));

describe("combo", () => {
  it("names a letter by the key pressed, whatever the layout types", () => {
    expect(named({ key: "j", code: "KeyJ" })).toBe("j");
    // Russian and Armenian layouts: the same key types another letter.
    expect(named({ key: "о", code: "KeyJ" })).toBe("j");
    expect(named({ key: "ս", code: "KeyS" })).toBe("s");
    expect(named({ key: "к", code: "KeyR", metaKey: true })).toBe("mod+r");
  });

  it("names a digit by the key pressed", () => {
    expect(named({ key: "1", code: "Digit1" })).toBe("1");
    // French layout: the digit row types symbols unless Shift is held.
    expect(named({ key: "&", code: "Digit1" })).toBe("1");
  });

  it("takes Shift from the Shift key, never from the letter's case", () => {
    expect(named({ key: "S", code: "KeyS", shiftKey: true })).toBe("shift+s");
    // Caps Lock types a capital without Shift.
    expect(named({ key: "S", code: "KeyS" })).toBe("s");
    expect(named({ key: "z", code: "KeyZ", metaKey: true })).toBe("mod+z");
    expect(named({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true })).toBe("mod+shift+z");
    expect(named({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true })).toBe("mod+shift+z");
  });

  it("names Option with a letter on a Mac by the key, not by the character it makes", () => {
    expect(named({ key: "Dead", code: "KeyU", altKey: true })).toBe("alt+u");
    expect(named({ key: "¨", code: "KeyU", altKey: true })).toBe("alt+u");
    expect(named({ key: "ø", code: "KeyO", altKey: true })).toBe("alt+o");
  });

  it("names a typed sign by the character, Shift and all", () => {
    expect(named({ key: "?", code: "Slash", shiftKey: true })).toBe("?");
    expect(named({ key: "/", code: "Slash" })).toBe("/");
    expect(named({ key: "[", code: "BracketLeft" })).toBe("[");
    // German layout on a Mac: [ is Option+5.
    expect(named({ key: "[", code: "Digit5", altKey: true })).toBe("[");
    expect(named({ key: "=", code: "Equal" })).toBe("=");
  });

  it("names a sign held with Cmd or Ctrl by the key, with Shift", () => {
    expect(named({ key: ".", code: "Period", metaKey: true })).toBe("mod+.");
    expect(named({ key: ">", code: "Period", metaKey: true, shiftKey: true })).toBe("mod+shift+.");
    expect(named({ key: "<", code: "Comma", metaKey: true, shiftKey: true })).toBe("mod+shift+,");
    expect(named({ key: "[", code: "BracketLeft", metaKey: true })).toBe("mod+[");
  });

  it("names the other keys by their names, with Shift", () => {
    expect(named({ key: "Enter", code: "Enter" })).toBe("Enter");
    expect(named({ key: " ", code: "Space" })).toBe(" ");
    expect(named({ key: " ", code: "Space", shiftKey: true })).toBe("shift+ ");
    expect(named({ key: "Backspace", code: "Backspace", metaKey: true })).toBe("mod+Backspace");
    expect(named({ key: "ArrowDown", code: "ArrowDown" })).toBe("ArrowDown");
  });

  it("names a letter by its character when the event has no key code", () => {
    expect(named({ key: "j" })).toBe("j");
    expect(named({ key: "J", shiftKey: true })).toBe("shift+j");
  });
});

describe("useHotkeys", () => {
  it("runs a bare key pressed on the page", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} />);
    press("s");
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("does not run a bare letter's key for the letter with Shift", () => {
    const status = vi.fn();
    const shifted = vi.fn();
    render(<Keys keys={{ s: status, "shift+s": shifted }} />);
    press("S", { code: "KeyS", shiftKey: true });
    expect(status).not.toHaveBeenCalled();
    expect(shifted).toHaveBeenCalledTimes(1);
    // Caps Lock on: still the bare key.
    press("S", { code: "KeyS" });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("leaves a bare key alone while a dialog is open", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} overlay="open" />);
    press("s");
    expect(status).not.toHaveBeenCalled();
  });

  it("runs a bare key while a dialog that has closed is still leaving", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} overlay="closed" />);
    press("s");
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("runs a bare key while a panel beside the page is open", () => {
    const create = vi.fn();
    render(<Keys keys={{ c: create }} overlay="open" beside />);
    press("c");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("runs a chord in a field, unless chords are held to the rules of bare keys", () => {
    const copy = vi.fn();
    const { getByLabelText, unmount } = render(<Keys keys={{ "mod+.": copy }} />);
    fireEvent.keyDown(getByLabelText("field"), { key: ".", code: "Period", metaKey: true });
    expect(copy).toHaveBeenCalledTimes(1);
    unmount();

    const guarded = vi.fn();
    const again = render(<Keys keys={{ "mod+.": guarded }} guardChords />);
    fireEvent.keyDown(again.getByLabelText("field"), { key: ".", code: "Period", metaKey: true });
    expect(guarded).not.toHaveBeenCalled();
    press(".", { code: "Period", metaKey: true });
    expect(guarded).toHaveBeenCalledTimes(1);
  });
});

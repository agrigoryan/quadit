// @vitest-environment jsdom
// Two keys in a row, "G then a letter" (hooks/key-sequence.ts).

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEQUENCE_MS, type Sequences, useKeySequences, usePendingKey } from "@/hooks/key-sequence";

function Keys({ sequences }: { sequences: Sequences }) {
  useKeySequences(sequences);
  return <input aria-label="field" />;
}

/** Presses a key on the page (not in a field); returns whether something used it up. */
const press = (key: string) => !fireEvent.keyDown(document.body, { key });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("useKeySequences", () => {
  it("runs the second key when it comes within the window, and uses it up", () => {
    const inbox = vi.fn();
    render(<Keys sequences={{ g: { i: inbox } }} />);
    expect(press("g")).toBe(false);
    expect(usePendingKey.getState().prefix).toBe("g");
    vi.advanceTimersByTime(SEQUENCE_MS - 100);
    expect(press("I")).toBe(true);
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(usePendingKey.getState().prefix).toBeNull();
  });

  it("forgets the first key once the window has passed", () => {
    const inbox = vi.fn();
    render(<Keys sequences={{ g: { i: inbox } }} />);
    press("g");
    vi.advanceTimersByTime(SEQUENCE_MS + 1);
    expect(usePendingKey.getState().prefix).toBeNull();
    expect(press("i")).toBe(false);
    expect(inbox).not.toHaveBeenCalled();
  });

  it("ends the sequence on a key that leads nowhere, which is used up and runs nothing", () => {
    const inbox = vi.fn();
    render(<Keys sequences={{ g: { i: inbox } }} />);
    press("g");
    expect(press("x")).toBe(true);
    expect(press("i")).toBe(false);
    expect(inbox).not.toHaveBeenCalled();
  });

  it("does nothing for keys typed in a field", () => {
    const inbox = vi.fn();
    const { getByLabelText } = render(<Keys sequences={{ g: { i: inbox } }} />);
    const field = getByLabelText("field");
    fireEvent.keyDown(field, { key: "g" });
    expect(usePendingKey.getState().prefix).toBeNull();

    // A field that takes the focus between the two keys gets the second.
    press("g");
    expect(fireEvent.keyDown(field, { key: "i" })).toBe(true);
    expect(inbox).not.toHaveBeenCalled();
  });
});

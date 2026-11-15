// @vitest-environment jsdom
// Something shown once a condition has held for a moment (lib/use-delayed-flag.ts).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "@/lib/use-delayed-flag";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** The hook with a delay of 900 ms; `drawn` is every value it gave, render by render. */
function flag(on: boolean) {
  const drawn: boolean[] = [];
  const hook = renderHook(
    ({ on }) => {
      const shown = useDelayedFlag(on, 900);
      drawn.push(shown);
      return shown;
    },
    { initialProps: { on } },
  );
  return { ...hook, drawn };
}

describe("useDelayedFlag", () => {
  it("turns on once the condition has held for the delay", () => {
    const { result } = flag(true);
    expect(result.current).toBe(false);
    wait(899);
    expect(result.current).toBe(false);
    wait(1);
    expect(result.current).toBe(true);
  });

  it("turns off at once when the condition ends, and waits again when it comes back", () => {
    const { result, rerender, drawn } = flag(true);
    wait(900);
    const before = drawn.length;
    rerender({ on: false });
    expect(drawn.slice(before)).not.toContain(true);
    rerender({ on: true });
    expect(result.current).toBe(false);
    wait(900);
    expect(result.current).toBe(true);
  });

  it("never shows a flicker shorter than the delay", () => {
    const { result, rerender } = flag(true);
    wait(500);
    rerender({ on: false });
    wait(500);
    rerender({ on: true });
    wait(500);
    expect(result.current).toBe(false);
    wait(400);
    expect(result.current).toBe(true);
  });

  it("stays off while the condition is false, and counts the delay from when it turns true", () => {
    const { rerender, drawn } = flag(false);
    wait(5000);
    rerender({ on: true });
    wait(899);
    expect(drawn).not.toContain(true);
  });

  it("clears its timer when it leaves the screen", () => {
    const { unmount } = flag(true);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, letInputIn } from "@/pages/hold-input";

describe("letInputIn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets input in at once on a page the person opened", () => {
    const page = { inert: true };
    letInputIn(page, false);
    expect(page.inert).toBe(false);
  });

  it("holds it for its first 700 ms on screen on a page a server's page opened", () => {
    const page = { inert: true };
    letInputIn(page, true);
    expect(HOLD_MS).toBe(700);
    vi.advanceTimersByTime(699);
    expect(page.inert).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.inert).toBe(false);
  });

  it("holds it again for 700 ms when asked again later, the earlier hold's end letting nothing in", () => {
    const page = { inert: true };
    letInputIn(page, true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(page.inert).toBe(false);
    letInputIn(page, true);
    expect(page.inert).toBe(true);
    vi.advanceTimersByTime(500);
    letInputIn(page, true);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(page.inert).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.inert).toBe(false);
  });
});

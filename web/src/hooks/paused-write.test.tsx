// @vitest-environment jsdom
// A write that waits for typing to pause, and is never lost to a reload, a
// closed tab or a component going away (hooks/paused-write.ts).

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pausedWrite, usePausedWrite } from "@/hooks/paused-write";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hide() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("pausedWrite", () => {
  it("runs the last write held once typing has paused for the wait", () => {
    const write = vi.fn();
    const title = pausedWrite(500);
    title.hold(() => write("R"));
    vi.advanceTimersByTime(300);
    title.hold(() => write("Ro"));
    vi.advanceTimersByTime(300);
    title.hold(() => write("Roadmap"));
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("Roadmap");
  });

  it("runs the write that waits at once when the page goes away", () => {
    const write = vi.fn();
    pausedWrite(500).hold(() => write("Roadmap"));
    window.dispatchEvent(new Event("pagehide"));
    expect(write).toHaveBeenCalledWith("Roadmap");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("runs the write that waits at once when the page is hidden", () => {
    const write = vi.fn();
    pausedWrite(500).hold(() => write("Roadmap"));
    hide();
    expect(write).toHaveBeenCalledWith("Roadmap");
  });

  it("runs nothing when nothing waits, and nothing after a cancel", () => {
    const write = vi.fn();
    const title = pausedWrite(500);
    title.flush();
    title.hold(write);
    expect(title.waiting).toBe(true);
    title.cancel();
    expect(title.waiting).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(500);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("usePausedWrite", () => {
  it("runs the write that waits when the component goes", () => {
    const write = vi.fn();
    const { result, unmount } = renderHook(() => usePausedWrite(350));
    result.current.hold(write);
    unmount();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

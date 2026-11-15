// When to try again (lib/api.ts): whenReachable's waits, and what ends them early.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NetworkError, noteReachable, onReachableAgain, whenReachable } from "@/lib/api";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";

let server: FakeServer;
let browser: EventTarget;

/** Starts a wait and says whether it has ended. */
function wait(attempt: number, signal?: AbortSignal) {
  const state = { ended: false, failed: undefined as unknown };
  whenReachable(attempt, signal).then(
    () => (state.ended = true),
    (err: unknown) => (state.failed = err),
  );
  return state;
}

const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  server = fakeServer();
  browser = new EventTarget();
  vi.stubGlobal("window", browser);
  server.get("/ok", {});
  server.get("/refused", refuse(403, "no"));
});

afterEach(async () => {
  // The next test starts with a server that was last heard from.
  server.down = false;
  await api.get("/ok");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("whenReachable", () => {
  it("waits at most a second, then twice as long each time, up to fifteen seconds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const longest = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];
    for (const [attempt, ms] of longest.entries()) {
      const waiting = wait(attempt);
      await later(ms - 1);
      expect(waiting.ended, `attempt ${attempt}`).toBe(false);
      await later(1);
      expect(waiting.ended, `attempt ${attempt}`).toBe(true);
    }
  });

  it("shortens a wait at random, by no more than half", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const shortest = wait(2);
    await later(1999);
    expect(shortest.ended).toBe(false);
    await later(1);
    expect(shortest.ended).toBe(true);

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const between = wait(2);
    await later(2999);
    expect(between.ended).toBe(false);
    await later(1);
    expect(between.ended).toBe(true);
  });

  it("ends at once when the browser comes back online", async () => {
    const waiting = wait(4);
    browser.dispatchEvent(new Event("online"));
    await later(0);
    expect(waiting.ended).toBe(true);
  });

  it("ends at once when a call gets an answer after one that got none, even if the answer is a refusal", async () => {
    server.down = true;
    await expect(api.get("/ok")).rejects.toBeInstanceOf(NetworkError);
    const first = wait(4);
    server.down = false;
    await api.get("/ok");
    await later(0);
    expect(first.ended).toBe(true);

    server.down = true;
    await expect(api.get("/ok")).rejects.toBeInstanceOf(NetworkError);
    const second = wait(4);
    server.down = false;
    await expect(api.get("/refused")).rejects.toBeInstanceOf(ApiError);
    await later(0);
    expect(second.ended).toBe(true);
  });

  it("is not ended by calls that succeed while nothing has failed", async () => {
    const waiting = wait(4);
    await api.get("/ok");
    await later(7000);
    expect(waiting.ended).toBe(false);
  });

  it("ends at once when the live stream is said to have opened", async () => {
    const waiting = wait(4);
    noteReachable();
    await later(0);
    expect(waiting.ended).toBe(true);
  });

  it("rejects with the signal's reason when given up, at once if it already was", async () => {
    const giveUp = new AbortController();
    const waiting = wait(4, giveUp.signal);
    giveUp.abort();
    await later(0);
    expect(waiting.ended).toBe(false);
    expect(waiting.failed).toBe(giveUp.signal.reason);
    expect(giveUp.signal.reason).toMatchObject({ name: "AbortError" });

    const already = wait(0, giveUp.signal);
    await later(0);
    expect(already.failed).toBe(giveUp.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("onReachableAgain", () => {
  it("hears the first answer after a call that got none, once, and nothing once it stops listening", async () => {
    const heard = vi.fn();
    const stop = onReachableAgain(heard);
    await api.get("/ok");
    expect(heard).not.toHaveBeenCalled();

    server.down = true;
    await expect(api.get("/ok")).rejects.toBeInstanceOf(NetworkError);
    await expect(api.post("/ok")).rejects.toBeInstanceOf(NetworkError);
    expect(heard).not.toHaveBeenCalled();
    server.down = false;
    await api.get("/ok");
    await api.get("/ok");
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    server.down = true;
    await expect(api.get("/ok")).rejects.toBeInstanceOf(NetworkError);
    server.down = false;
    await api.get("/ok");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("is not told when the stream is said to have opened: whoever says that already knows", async () => {
    const heard = vi.fn();
    const stop = onReachableAgain(heard);
    server.down = true;
    await expect(api.get("/ok")).rejects.toBeInstanceOf(NetworkError);
    server.down = false;
    noteReachable();
    await api.get("/ok");
    expect(heard).not.toHaveBeenCalled();
    stop();
  });
});

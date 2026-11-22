// When to try again (data/api.ts): whenReachable's waits, and what ends them early; a
// request called off is not a network failure; a read left unanswered is one;
// and a read of a file's first bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NetworkError, noteReachable, onReachableAgain, whenReachable } from "@/data/api";
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

describe("a request called off", () => {
  it("fails as called off, not as unreachable, also when the abort comes from another realm", async () => {
    // jsdom, an iframe: the error is named AbortError but is not this realm's DOMException.
    const foreign = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(foreign);
    await expect(api.get("/ok")).rejects.toBe(foreign);
  });

  it("fails as called off when its signal was, whatever the error says", async () => {
    const stop = new AbortController();
    stop.abort();
    const reason = new Error("left the page");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(reason);
    await expect(api.get("/ok", stop.signal)).rejects.toBe(reason);
  });
});

describe("a read the server does not begin to answer", () => {
  it("is given up after twenty seconds, and counts as the server not reached", async () => {
    const slow = server.hold("/slow");
    const read = api.get("/slow").catch((err: unknown) => err);
    await later(19_999);
    expect(slow.calls[0]?.aborted).toBe(false);
    await later(1);
    expect(slow.calls[0]?.aborted).toBe(true);
    expect(await read).toBeInstanceOf(NetworkError);
  });

  /** A fetch whose answer begins after `headersAt` and whose body takes `bodyTakes` more; it notes the signal it was given. */
  function answersSlowly(headersAt: number, bodyTakes: number) {
    const seen = { signal: undefined as AbortSignal | undefined };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_path, init) => {
      const signal = init?.signal ?? undefined;
      seen.signal = signal;
      const text = () =>
        new Promise<string>((arrived, lost) => {
          setTimeout(() => arrived('{"n":1}'), bodyTakes);
          signal?.addEventListener("abort", () => lost(new DOMException("The operation was aborted.", "AbortError")));
        });
      return new Promise<Response>((begun) => setTimeout(() => begun({ status: 200, text } as Response), headersAt));
    });
    return seen;
  }

  it("is held to the time only until the answer begins: the rest may take as long as it takes", async () => {
    const seen = answersSlowly(19_000, 60_000);
    const read = api.get("/slow");
    await later(79_000);
    expect(await read).toEqual({ n: 1 });
    expect(seen.signal?.aborted).toBe(false);
  });

  it("can still be called off while the rest of the answer arrives, and then fails as called off", async () => {
    const seen = answersSlowly(1000, 60_000);
    const stop = new AbortController();
    const read = api.get("/slow", stop.signal).catch((err: unknown) => err);
    await later(5000);
    stop.abort();
    const failed = await read;
    expect(seen.signal?.aborted).toBe(true);
    expect(failed).not.toBeInstanceOf(NetworkError);
    expect(failed).toMatchObject({ name: "AbortError" });
  });

  it("waits longer for a read that says its answer takes longer to begin", async () => {
    const slow = server.hold("/slow");
    const read = api.get("/slow", undefined, { startsWithin: 120_000 }).catch((err: unknown) => err);
    await later(119_999);
    expect(slow.calls[0]?.aborted).toBe(false);
    await later(1);
    expect(await read).toBeInstanceOf(NetworkError);
  });

  it("fails as called off, not as unreachable, when its own signal ends it first", async () => {
    const slow = server.hold("/slow");
    const stop = new AbortController();
    const read = api.get("/slow", stop.signal).catch((err: unknown) => err);
    await later(5000);
    stop.abort();
    expect(await read).not.toBeInstanceOf(NetworkError);
    expect(slow.calls[0]?.aborted).toBe(true);
  });

  it("leaves a write to end by itself: whether it arrived is not known", async () => {
    const slow = server.hold("/slow", "POST");
    const write = api.post("/slow", {});
    await later(120_000);
    expect(slow.calls[0]?.aborted).toBe(false);
    slow.calls[0]?.answer({ done: true });
    expect(await write).toEqual({ done: true });
  });
});

describe("a read of a file's first bytes", () => {
  /** A fetch that answers with these bytes, or with a body that never ends; it notes what it was asked. */
  function answersBytes(bytes: Uint8Array<ArrayBuffer> | "never ends", status = 200) {
    const seen = { headers: {} as Record<string, string>, signal: undefined as AbortSignal | undefined };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_path, init) => {
      seen.headers = (init?.headers ?? {}) as Record<string, string>;
      const signal = init?.signal ?? undefined;
      seen.signal = signal;
      const body =
        bytes === "never ends"
          ? new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new Uint8Array([104, 105]));
                // As a real fetch does: the body ends with an AbortError when the request is called off.
                signal?.addEventListener("abort", () =>
                  stream.error(new DOMException("The operation was aborted.", "AbortError")),
                );
              },
            })
          : bytes;
      return Promise.resolve(new Response(body, { status }));
    });
    return seen;
  }

  it("asks for only those bytes, and keeps no more than them if the server sends more", async () => {
    const seen = answersBytes(new TextEncoder().encode("hello world"));
    const got = await api.bytes("/f/1/notes.txt", 5);
    expect(seen.headers.Range).toBe("bytes=0-4");
    expect(new TextDecoder().decode(got)).toBe("hello");
  });

  it("fails as any read does when the server refuses", async () => {
    answersBytes(new TextEncoder().encode(JSON.stringify({ error: { message: "file not found" } })), 404);
    await expect(api.bytes("/f/1/notes.txt", 5)).rejects.toMatchObject({ status: 404, message: "file not found" });
  });

  it("is given up when the whole answer has not arrived in thirty seconds, as the server not reached", async () => {
    const seen = answersBytes("never ends");
    const read = api.bytes("/f/1/notes.txt", 5).catch((err: unknown) => err);
    await later(29_999);
    expect(seen.signal?.aborted).toBe(false);
    await later(1);
    expect(await read).toBeInstanceOf(NetworkError);
  });
});

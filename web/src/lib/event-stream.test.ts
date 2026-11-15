// Reading the live stream (lib/event-stream.ts) from a fetch that the test feeds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventStreamHandlers, openEventStream } from "@/lib/event-stream";
import type { FeedEvent } from "@/lib/types";

/** A response body the test writes to, chunk by chunk. */
function serve(status = 200) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(status === 200 ? body : null, { status }))),
  );
  const bytes = new TextEncoder();
  return {
    write: (chunk: string | Uint8Array) => controller?.enqueue(typeof chunk === "string" ? bytes.encode(chunk) : chunk),
    end: () => controller?.close(),
  };
}

function listen() {
  const heard = { events: [] as FeedEvent[][], signals: [] as string[], closed: [] as (number | null)[], opened: 0 };
  const handlers: EventStreamHandlers = {
    onOpen: () => heard.opened++,
    onEvents: (events) => heard.events.push(events),
    onSignal: (name) => heard.signals.push(name),
    onClose: (status) => heard.closed.push(status),
  };
  return { heard, handlers };
}

/** Lets the reading loop take what was written. */
const flush = () => vi.advanceTimersByTimeAsync(0);
const seqs = (batches: FeedEvent[][]) => batches.map((batch) => batch.map((ev) => ev.seq));

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openEventStream", () => {
  it("puts together a message split across chunks, and gives events that arrive together together", async () => {
    const server = serve();
    const { heard, handlers } = listen();
    openEventStream("/events", handlers);
    await flush();
    expect(heard.opened).toBe(1);

    server.write('data: {"seq":1,');
    await flush();
    expect(heard.events).toEqual([]);
    server.write('"title":"caf');
    // "é" is two bytes; the chunk ends between them.
    const e = new TextEncoder().encode("é");
    server.write(e.slice(0, 1));
    server.write(new Uint8Array([...e.slice(1), ...new TextEncoder().encode('"}\n\ndata: {"seq":2}\n\n')]));
    await flush();
    expect(seqs(heard.events)).toEqual([[1, 2]]);
    expect(heard.events[0]?.[0]).toMatchObject({ title: "café" });
  });

  it("reads lines ended with CRLF, even when the pair is split across chunks", async () => {
    const server = serve();
    const { heard, handlers } = listen();
    openEventStream("/events", handlers);
    server.write('data: {"seq":3}\r\n\r');
    server.write('\ndata: {"seq":4}\r\n\r\n');
    await flush();
    expect(seqs(heard.events).flat()).toEqual([3, 4]);
  });

  it("gives the events before a signal first, and skips heartbeats", async () => {
    const server = serve();
    const { heard, handlers } = listen();
    openEventStream("/events", handlers);
    server.write(': heartbeat\n\ndata: {"seq":5}\n\nevent: reset\ndata: {}\n\ndata: {"seq":6}\n\n');
    await flush();
    expect(seqs(heard.events)).toEqual([[5], [6]]);
    expect(heard.signals).toEqual(["reset"]);
  });

  it("closes a stream that stays silent past a minute, and only then", async () => {
    const server = serve();
    const { heard, handlers } = listen();
    openEventStream("/events", handlers);
    await flush();
    await vi.advanceTimersByTimeAsync(50_000);
    server.write(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(heard.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heard.closed).toEqual([null]);
  });

  it("reports a refusal with its status, and an ended stream without one", async () => {
    serve(401);
    const refused = listen();
    openEventStream("/events", refused.handlers);
    await flush();
    expect(refused.heard).toMatchObject({ opened: 0, closed: [401] });

    const server = serve();
    const ended = listen();
    openEventStream("/events", ended.handlers);
    server.end();
    await flush();
    expect(ended.heard).toMatchObject({ opened: 1, closed: [null] });
  });

  it("calls nothing after close()", async () => {
    const server = serve();
    const { heard, handlers } = listen();
    const stream = openEventStream("/events", handlers);
    await flush();
    stream.close();
    server.write('data: {"seq":7}\n\n');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heard.events).toEqual([]);
    expect(heard.closed).toEqual([]);
  });
});

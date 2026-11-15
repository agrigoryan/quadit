// Reads the live stream (/events/stream, server-sent events) over fetch.
//
// The browser's own EventSource cannot tell a quiet stream from a dead one:
// a connection that dies without an error (a sleeping laptop, a proxy that
// lost its server) stays "open" for ever, and the server's heartbeats, being
// comments, are never shown to the page. Reading the bytes ourselves we see
// the heartbeats, and a stream silent for too long is closed and reported.
// We also see the status when the server refuses the stream (401, 403, 404)
// instead of a bare "error".
//
// This only reads one connection. Opening it again (from the last position
// applied) is the caller's business: lib/sync.ts.

import type { FeedEvent } from "@/lib/types";

/** The server writes a heartbeat every 25 seconds. Two missed and a margin: the connection is dead. */
const QUIET_MS = 60_000;

export interface EventStreamHandlers {
  /** The server accepted the stream. */
  onOpen(): void;
  /** Feed events, in order. Those that arrive together are given together. */
  onEvents(events: FeedEvent[]): void;
  /** A named message: "reset" (start over) or "gone" (leave). */
  onSignal(name: string): void;
  /**
   * The stream ended, went silent, or could not be opened. `status` is the
   * HTTP status when the server answered with a refusal, else null. Not
   * called after close().
   */
  onClose(status: number | null): void;
}

export interface EventStream {
  close(): void;
}

export function openEventStream(url: string, handlers: EventStreamHandlers): EventStream {
  const abort = new AbortController();
  let closed = false;
  let heard = Date.now();
  let watch: ReturnType<typeof setInterval> | undefined;

  const end = (status: number | null) => {
    if (closed) return;
    closed = true;
    clearInterval(watch);
    abort.abort();
    handlers.onClose(status);
  };

  /** Handles the complete messages in `text`; returns what is left of an unfinished one. */
  const read = (text: string): string => {
    const events: FeedEvent[] = [];
    let rest = text;
    for (let at = rest.indexOf("\n\n"); at >= 0 && !closed; at = rest.indexOf("\n\n")) {
      const block = rest.slice(0, at);
      rest = rest.slice(at + 2);
      let name = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
        // "id:", "retry:" and comments (the heartbeat) carry nothing we need.
      }
      if (name) {
        // What came before a signal is applied before it.
        if (events.length) handlers.onEvents(events.splice(0));
        handlers.onSignal(name);
      } else if (data) {
        try {
          events.push(JSON.parse(data) as FeedEvent);
        } catch {
          // Not an event: skip it.
        }
      }
    }
    if (events.length && !closed) handlers.onEvents(events);
    return rest;
  };

  void (async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal,
      });
    } catch {
      return end(null);
    }
    // 204: the server will not stream to this session (one made to take a picture of a page).
    if (!res.ok || res.status === 204 || !res.body) return end(res.ok && res.status !== 204 ? null : res.status);
    if (closed) return;
    heard = Date.now();
    watch = setInterval(() => {
      if (Date.now() - heard > QUIET_MS) end(null);
    }, 10_000);
    handlers.onOpen();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        heard = Date.now();
        pending = read((pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n"));
      }
    } catch {
      // The connection dropped.
    }
    end(null);
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(watch);
      abort.abort();
    },
  };
}

// Keeps the store current: one bootstrap, then the live stream. If the
// stream drops it is reopened from the last position applied; after a long
// gap, or when the server says "reset", the whole copy is fetched again.

import { api, ApiError, ws } from "@/lib/api";
import { applyEvents, type BootstrapData, getState, loadBootstrap, useStore } from "@/lib/store";
import type { FeedEvent } from "@/lib/types";

const RETRY_MS = 3000;
/** Past this long without the stream, start from a fresh copy instead of replaying. */
const LONG_GAP_MS = 5 * 60_000;

let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let downSince = 0;
let generation = 0;
let buffer: FeedEvent[] = [];
let flushQueued = false;

async function bootstrap(slug: string) {
  const data = await api.get<BootstrapData>(ws(slug, "/bootstrap"));
  loadBootstrap(slug, data);
}

/** Loads the workspace and follows it. Throws if the first load fails. */
export async function startSync(slug: string) {
  stopSync();
  const mine = ++generation;
  useStore.setState({ stream: "connecting" });
  await bootstrap(slug);
  if (mine === generation) openStream(slug, mine);
}

export function stopSync() {
  generation++;
  clearTimeout(retryTimer);
  source?.close();
  source = null;
  buffer = [];
  downSince = 0;
}

function flush() {
  flushQueued = false;
  const events = buffer;
  buffer = [];
  if (events.length) applyEvents(events, true);
}

function openStream(slug: string, mine: number) {
  source?.close();
  const es = new EventSource(ws(slug, `/events/stream?after=${getState().seq}`));
  source = es;

  es.onopen = () => {
    if (mine !== generation) return;
    const gap = downSince ? Date.now() - downSince : 0;
    downSince = 0;
    if (gap > LONG_GAP_MS) {
      void restart(slug, mine);
      return;
    }
    useStore.setState({ stream: "live" });
  };

  es.onmessage = (msg) => {
    if (mine !== generation) return;
    try {
      buffer.push(JSON.parse(msg.data as string) as FeedEvent);
    } catch {
      return;
    }
    // Events that arrive together are applied together: one render.
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  };

  es.addEventListener("reset", () => {
    if (mine === generation) void restart(slug, mine);
  });

  es.onerror = () => {
    if (mine !== generation) return;
    downSince ||= Date.now();
    useStore.setState({ stream: "down" });
    // The browser retries by itself from the last event id. Once it gives
    // up (the server refused the stream), reopen by hand.
    if (es.readyState === EventSource.CLOSED) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void reopen(slug, mine), RETRY_MS);
    }
  };
}

/** Reopens a stream the browser gave up on, from where the store stands. */
async function reopen(slug: string, mine: number) {
  if (mine !== generation) return;
  try {
    // A 401 here sends the person to sign in (api.onUnauthorized).
    await api.get("/api/v1/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    retryTimer = setTimeout(() => void reopen(slug, mine), RETRY_MS);
    return;
  }
  if (mine !== generation) return;
  if (downSince && Date.now() - downSince > LONG_GAP_MS) await restart(slug, mine);
  else openStream(slug, mine);
}

/** Fetches a fresh copy, then follows the stream from it. */
async function restart(slug: string, mine: number) {
  source?.close();
  source = null;
  try {
    await bootstrap(slug);
  } catch {
    if (mine === generation) retryTimer = setTimeout(() => void restart(slug, mine), RETRY_MS);
    return;
  }
  if (mine !== generation) return;
  downSince = 0;
  openStream(slug, mine);
}

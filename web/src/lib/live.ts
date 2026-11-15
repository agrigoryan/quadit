// Reads that only the server can answer (waiting times, weekly counts, agent
// cost), kept fresh: fetched when the page opens and again, at most once
// every couple of seconds, whenever the feed moves.

import { useEffect, useRef, useState } from "react";
import { api, errorMessage, workspacePath } from "@/lib/api";
import { onEvents, useStore } from "@/lib/store";

export interface Live<T> {
  data: T | undefined;
  /** Why the last fetch failed, or "". The last good answer stays in `data`. */
  error: string;
  /** True until the first answer (or failure) arrives. */
  loading: boolean;
  /** True while a newer answer is on its way; show the old one dimmed, not a spinner. */
  refreshing: boolean;
  refetch: () => void;
}

/**
 * GET a path under the workspace (`/dashboard?project=SVA`) and keep the
 * answer current. Pass null to fetch nothing. `only` narrows which feed
 * events cause a refetch (by entity type); leave it out to follow them all.
 */
export function useLive<T>(path: string | null, opts: { throttleMs?: number; only?: string[] } = {}): Live<T> {
  const slug = useStore((s) => s.slug);
  const live = useStore((s) => s.stream === "live");
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string;
    loading: boolean;
    refreshing: boolean;
  }>({
    path,
    error: "",
    loading: path !== null,
    refreshing: false,
  });
  const throttle = opts.throttleMs ?? 2000;
  const only = opts.only?.join(",") ?? "";
  const run = useRef<() => void>(() => {});

  useEffect(() => {
    if (path === null) return;
    let current = true;
    let busy = false;
    let again = false;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      last = Date.now();
      setState((s) =>
        s.path === path ? { ...s, refreshing: !s.loading } : { path, error: "", loading: true, refreshing: false },
      );
      try {
        const data = await api.get<T>(workspacePath(slug, path as string));
        if (current) setState({ path, data, error: "", loading: false, refreshing: false });
      } catch (err) {
        if (current) setState((s) => ({ ...s, path, error: errorMessage(err), loading: false, refreshing: false }));
      }
      busy = false;
      if (again && current) {
        again = false;
        schedule();
      }
    }

    function schedule() {
      if (timer) return;
      const wait = Math.max(0, last + throttle - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, wait);
    }

    run.current = schedule;
    void load();
    const kinds = only ? new Set(only.split(",")) : null;
    const off = onEvents((events) => {
      if (!kinds || events.some((ev) => kinds.has(ev.entity_type))) schedule();
    });
    return () => {
      current = false;
      clearTimeout(timer);
      off();
    };
    // `live` is here so that a stream that comes back fetches what was missed.
  }, [slug, path, throttle, only, live]);

  const fresh = state.path === path;
  return {
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : "",
    loading: fresh ? state.loading : path !== null,
    refreshing: fresh && state.refreshing,
    refetch: () => run.current(),
  };
}

/** The time now, updated on a slow tick, for "elapsed" and "until" readouts. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

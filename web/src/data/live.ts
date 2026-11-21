// Reads that only the server can answer (waiting times, weekly counts, agent
// cost), kept fresh: read through the query cache when the page opens, and
// asked again, at most once every couple of seconds, whenever the feed moves
// (the cache asks again when the stream comes back). Two pages reading the
// same path share one answer. The key they are cached under is here.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, workspacePath } from "@/data/api";
import { inWorkspace, queryClient, readError } from "@/data/query";
import { onEvents, useStore } from "@/data/store";

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

/** The key a live read of `path` is cached under. */
export const liveKey = (slug: string, path: string | null) => [...inWorkspace(slug), "live", path] as const;

/**
 * GET a path under the workspace (`/dashboard?project=SVA`) and keep the
 * answer current. Pass null to fetch nothing. `only` narrows which feed
 * events cause a refetch (by entity type); leave it out to follow them all.
 * `everyMs` also reads it again on that beat while it is shown, for an
 * answer that changes without an event (the server's clock decides it).
 */
export function useLive<T>(
  path: string | null,
  opts: { throttleMs?: number; only?: string[]; everyMs?: number } = {},
): Live<T> {
  const slug = useStore((s) => s.slug);
  const query = useQuery({
    queryKey: liveKey(slug, path),
    queryFn: ({ signal }) => api.get<T>(workspacePath(slug, path ?? ""), signal),
    enabled: path !== null,
    refetchInterval: opts.everyMs,
  });
  const throttle = opts.throttleMs ?? 2000;
  const only = opts.only?.join(",") ?? "";

  useEffect(() => {
    if (path === null) return;
    const key = liveKey(slug, path);
    const kinds = only ? new Set(only.split(",")) : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvents((events) => {
      if (timer || (kinds && !events.some((ev) => kinds.has(ev.entity_type)))) return;
      // Not sooner than `throttle` after the answer on screen was read.
      const read = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      timer = setTimeout(
        () => {
          timer = undefined;
          void queryClient.invalidateQueries({ queryKey: key });
        },
        Math.max(0, read + throttle - Date.now()),
      );
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [slug, path, throttle, only]);

  return {
    data: query.data,
    error: readError(query.error),
    loading: path !== null && query.isPending,
    refreshing: query.isFetching && !query.isPending,
    refetch: () => void query.refetch(),
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

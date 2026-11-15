// Lists that are not in the store (tokens, invitations, webhooks, install
// settings ...) are fetched by the page that shows them.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "@/lib/api";

export interface Loaded<T> {
  /** Undefined until the first answer. */
  data: T | undefined;
  /** The server's message when the fetch failed. */
  error: string;
  loading: boolean;
  /** Fetches again, keeping what is shown until the new answer is here. */
  reload: () => Promise<void>;
  /** Changes what is shown without asking the server (after a write that returned the new value). */
  set: (next: T | ((prev: T | undefined) => T | undefined)) => void;
}

/**
 *   const tokens = useLoad(() => api.get<{ tokens: Token[] }>(workspacePath(slug, "/tokens")).then((r) => r.tokens), [slug]);
 *
 * Runs `fetcher` when the page opens and whenever `deps` change.
 */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const latest = useRef(fetcher);
  latest.current = fetcher;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++run.current;
    setLoading(true);
    try {
      const out = await latest.current();
      if (mine !== run.current) return;
      setData(out);
      setError("");
    } catch (err) {
      if (mine !== run.current) return;
      // A 401 has already sent the person to sign in.
      if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
    } finally {
      if (mine === run.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      run.current++;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller passes the dependencies, as with useEffect itself
  }, deps);

  return { data, error, loading, reload, set: setData };
}

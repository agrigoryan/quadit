import { useEffect, useState } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import { forgetIfUnshared, loadPage } from "@/docs/store";
import type { BlockRow } from "@/docs/types";

export type PageState =
  | { status: "loading" }
  | { status: "error"; error: string; missing: boolean }
  | { status: "ready"; blocks: BlockRow[]; seq: number };

/** Fetches a page's blocks and what surrounds it (see docs/store.ts) when it is opened. */
export function usePage(docId: string): PageState {
  const [state, setState] = useState<PageState>({ status: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: "loading" });
    const attempt = (n: number) =>
      loadPage(docId, ctl.signal).then(
        (data) => setState({ status: "ready", blocks: data.blocks ?? [], seq: data.doc.content_seq ?? 0 }),
        (err: unknown) => {
          if (ctl.signal.aborted) return;
          const missing = err instanceof ApiError && err.status === 404;
          // A page made a moment ago may be asked for before the server has it.
          if (missing && n < 4) timer = setTimeout(() => void attempt(n + 1), 250 * (n + 1));
          else {
            if (missing) forgetIfUnshared(docId);
            setState({ status: "error", error: errorMessage(err), missing });
          }
        },
      );
    void attempt(0);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [docId]);
  return state;
}

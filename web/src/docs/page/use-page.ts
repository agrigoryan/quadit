import { useQuery } from "@tanstack/react-query";
import { retryWait } from "@/lib/api";
import { isNotFound, readError, retryUnreachable } from "@/lib/query";
import { useSlug } from "@/lib/selectors";
import { pageQuery } from "@/docs/store";
import type { BlockRow } from "@/lib/types-docs";

export type PageState =
  | { status: "loading" }
  | { status: "error"; error: string; missing: boolean }
  | { status: "ready"; blocks: BlockRow[]; seq: number };

/** How many times a page the server says is not there is asked for again: one made a moment ago may not be there yet. */
const NOT_YET_RETRIES = 4;

/**
 * Fetches a page's blocks and what surrounds it (see docs/store.ts) when it
 * is opened. The editor starts from a copy read for this opening, never from
 * one cached by an earlier visit.
 */
export function usePage(docId: string): PageState {
  const slug = useSlug();
  const page = useQuery({
    ...pageQuery(slug, docId),
    retry: (failures, err) => (isNotFound(err) ? failures < NOT_YET_RETRIES : retryUnreachable(failures, err)),
    retryDelay: (failures, err) => (isNotFound(err) ? 250 * (failures + 1) : retryWait(failures)),
  });
  if (page.data && page.isFetchedAfterMount) return { status: "ready", blocks: page.data.blocks, seq: page.data.seq };
  const error = page.isFetching ? "" : readError(page.error);
  if (error) return { status: "error", error, missing: isNotFound(page.error) };
  return { status: "loading" };
}

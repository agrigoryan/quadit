// The picture on a gallery card: the row's own cover, or else the first
// image in its page. Pages are fetched one by one, a few at a time, and the
// answer is kept until the page's content changes.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, workspacePath } from "@/data/api";
import { useSlug } from "@/data/selectors";
import { localPath } from "@/lib/url";
import { docsKeys } from "@/docs/store";
import type { BlockRow, Doc } from "@/types/docs";

/** The fetches waiting for one of the few that run at once. Written by slot and release. */
const waiting: (() => void)[] = [];
/** How many run now. Written by slot and release. */
let running = 0;

function slot(): Promise<void> {
  if (running < 4) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function firstImage(slug: string, rowId: string, signal: AbortSignal): Promise<string | null> {
  await slot();
  try {
    const out = await api.get<{ blocks: BlockRow[] }>(workspacePath(slug, `/docs/${rowId}`), signal);
    const images = (out.blocks ?? []).filter(
      (b) => b.type === "image" && typeof b.props?.url === "string" && b.props.url,
    );
    // Top-level blocks come in reading order; one nested deeper is second best.
    const top = images.filter((b) => !b.parent_id).sort((a, b) => (a.rank < b.rank ? -1 : 1))[0] ?? images[0];
    return top ? (localPath(String(top.props?.url)) ?? null) : null;
  } finally {
    release();
  }
}

/** The address of a row's cover picture, or null when it has none (or while looking, or when the look failed). */
export function useCover(row: Doc): string | null {
  const slug = useSlug();
  const found = useQuery({
    queryKey: docsKeys.cover(slug, row.id, row.content_seq ?? 0),
    queryFn: ({ signal }) => firstImage(slug, row.id, signal),
    enabled: !row.cover,
    // The answer for one version of the content stays right; a new version is a new key.
    staleTime: Infinity,
    // While a changed page is looked at again, the picture it had stays.
    placeholderData: keepPreviousData,
  });
  if (row.cover) return localPath(row.cover) ?? null;
  return found.data ?? null;
}

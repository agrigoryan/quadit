// The picture on a gallery card: the row's own cover, or else the first
// image in its page. Pages are fetched one by one, a few at a time, and the
// answer is kept until the page's content changes.

import { useEffect, useState } from "react";
import { api, workspacePath } from "@/lib/api";
import { getState } from "@/lib/store";
import { localPath } from "@/lib/url";
import type { BlockRow, Doc } from "@/lib/types-docs";

const found = new Map<string, { seq: number; url: string | null }>();
const waiting: (() => void)[] = [];
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

async function firstImage(rowId: string): Promise<string | null> {
  await slot();
  try {
    const out = await api.get<{ blocks: BlockRow[] }>(workspacePath(getState().slug, `/docs/${rowId}`));
    const images = (out.blocks ?? []).filter(
      (b) => b.type === "image" && typeof b.props?.url === "string" && b.props.url,
    );
    // Top-level blocks come in reading order; one nested deeper is second best.
    const top = images.filter((b) => !b.parent_id).sort((a, b) => (a.rank < b.rank ? -1 : 1))[0] ?? images[0];
    return top ? (localPath(String(top.props?.url)) ?? null) : null;
  } catch {
    return null;
  } finally {
    release();
  }
}

/** The address of a row's cover picture, or null when it has none (or while looking). */
export function useCover(row: Doc): string | null {
  const seq = row.content_seq ?? 0;
  const known = found.get(row.id);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (row.cover || found.get(row.id)?.seq === seq) return;
    let live = true;
    void firstImage(row.id).then((url) => {
      found.set(row.id, { seq, url });
      if (live) redraw((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [row.id, row.cover, seq]);
  if (row.cover) return localPath(row.cover) ?? null;
  return known?.url ?? null;
}

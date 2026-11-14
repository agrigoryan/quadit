// The trash for pages. The server has no list of deleted pages, so the
// trash shows the ones this browser saw go: those deleted here (kept in
// localStorage, so they survive a reload) and those the live feed reported.

import { useMemo } from "react";
import { create } from "zustand";
import { useMe } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { canSee, useDocs } from "@/docs/data";
import type { Doc } from "@/docs/types";

export interface Trashed {
  id: string;
  title: string;
  icon?: string;
  kind: string;
  deleted_at: number;
}

const key = () => `quadit.docs.trash.${getState().slug}`;

function read(): Trashed[] {
  try {
    return JSON.parse(localStorage.getItem(key()) ?? "[]") as Trashed[];
  } catch {
    return [];
  }
}

const useRemembered = create<{ slug: string; items: Trashed[] }>(() => ({ slug: "", items: [] }));

function save(items: Trashed[]) {
  useRemembered.setState({ slug: getState().slug, items });
  try {
    localStorage.setItem(key(), JSON.stringify(items.slice(0, 200)));
  } catch {
    // Private mode: the list lasts for this visit.
  }
}

function current(): Trashed[] {
  const s = useRemembered.getState();
  if (s.slug !== getState().slug) useRemembered.setState({ slug: getState().slug, items: read() });
  return useRemembered.getState().items;
}

export function rememberTrashed(doc: Doc) {
  if (doc.kind === "row") return;
  const item: Trashed = { id: doc.id, title: doc.title, icon: doc.icon, kind: doc.kind, deleted_at: Date.now() };
  save([item, ...current().filter((i) => i.id !== doc.id)]);
}

export function forgetTrashed(id: string) {
  save(current().filter((i) => i.id !== id));
}

/** Deleted pages this browser knows of, newest first. A page restored elsewhere drops out. */
export function useTrashed(): Trashed[] {
  const docs = useDocs();
  const me = useMe();
  const slug = getState().slug;
  const remembered = useRemembered((s) => (s.slug === slug ? s.items : null)) ?? current();
  return useMemo(() => {
    const out = new Map<string, Trashed>();
    for (const item of remembered) {
      const live = docs[item.id];
      if (live && !live.deleted_at) continue; // restored since
      out.set(item.id, item);
    }
    for (const doc of Object.values(docs)) {
      if (!doc.deleted_at || doc.kind === "row" || !canSee(doc, me.user_id) || out.has(doc.id)) continue;
      // Only the top of what went together: a page whose parent is also in the trash comes back with it.
      const parent = doc.parent_id ? docs[doc.parent_id] : undefined;
      if (parent?.deleted_at === doc.deleted_at) continue;
      out.set(doc.id, { id: doc.id, title: doc.title, icon: doc.icon, kind: doc.kind, deleted_at: doc.deleted_at });
    }
    return [...out.values()].sort((a, b) => b.deleted_at - a.deleted_at);
  }, [docs, remembered, me.user_id]);
}

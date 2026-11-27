// A page's comments as threads, and where each is in the page as it reads
// now: what the margin, the comments column and the Discussions list show.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { scrollBehavior } from "@/lib/motion";
import { useRowEvenIfGone } from "@/data/selectors";
import { useDocComments } from "@/docs/data";
import { pageUi, usePageUi } from "@/docs/page/state";
import type { EditorHandle } from "@/docs/editor/editor";
import type { ThreadReading } from "@/docs/editor/words";
import type { DocComment } from "@/types/docs";

export interface ThreadData {
  root: DocComment;
  replies: DocComment[];
  /** The block it is on (the first its words are in); undefined for a comment on the page itself. */
  blockId?: string;
}

/** Comments grouped into threads: each top-level comment with its replies. */
export function threadsOf(comments: DocComment[]): ThreadData[] {
  const byRoot = new Map<string, ThreadData>();
  for (const c of comments) {
    if (!c.parent_id)
      byRoot.set(c.id, { root: c, replies: [], blockId: c.subject_type === "doc_block" ? c.subject_id : undefined });
  }
  for (const c of comments) {
    if (c.parent_id) byRoot.get(c.parent_id)?.replies.push(c);
  }
  return [...byRoot.values()];
}

/** Whether a thread is on words of the page that are still there: those words carry its marker. */
export const onWords = (root: DocComment) => !!root.quote && !root.detached_at;

/** Whether a thread is on words or a block of the page, rather than the page as a whole or words taken out. */
export const inText = (th: ThreadData) => !!th.blockId && (!th.root.quote || onWords(th.root));

/**
 * The page's open threads: how many each block has, how many in all, how
 * many are on its text (words or a block), and the ids of those on words,
 * whose words are highlighted.
 */
export function useOpenThreads(docId: string): {
  perBlock: Record<string, number>;
  total: number;
  inText: number;
  onWords: string[];
} {
  const comments = useDocComments(docId);
  return useMemo(() => {
    const perBlock: Record<string, number> = {};
    const words: string[] = [];
    let total = 0;
    let text = 0;
    for (const th of threadsOf(comments)) {
      if (th.root.resolved_at) continue;
      total++;
      if (inText(th)) text++;
      if (th.blockId) perBlock[th.blockId] = (perBlock[th.blockId] ?? 0) + 1;
      if (onWords(th.root)) words.push(th.root.id);
    }
    return { perBlock, total, inText: text, onWords: words };
  }, [comments]);
}

/**
 * Leaves the thread open when it is resolved or deleted meanwhile (by
 * someone else, or from another place): nothing shows it any more, and
 * nothing should still hold Esc for it.
 */
export function useLeaveGoneThread() {
  const focusThread = usePageUi((s) => s.focusThread);
  const thread = useRowEvenIfGone("comments", focusThread ?? undefined);
  const gone = !!focusThread && (!thread || !!thread.resolved_at || !!thread.deleted_at);
  useEffect(() => {
    if (gone) pageUi.leaveThread();
  }, [gone]);
}

/** What a thread is about, as the page reads now. */
export type About =
  /** The page as a whole. */
  | { on: "page" }
  /** Words or a block of the page: their text (undefined while the editor has not been read). */
  | { on: "text"; text: string | undefined }
  /** Words taken out of the page since: the words as they were. */
  | { on: "removed"; text: string }
  /** A block taken out of the page. */
  | { on: "gone" };

export interface PageThread extends ThreadData {
  about: About;
  /** Where it is in the page while its words or its block are there: what to scroll to. */
  at?: { words: string } | { block: string };
}

/** What a page's text reads as for its threads, by page id: read once for all that show them (useReadThreads). */
export const useThreadReadings = create<{ byPage: Record<string, ThreadReading> }>(() => ({ byPage: {} }));

/**
 * Keeps what a page's text reads as for its threads current while the page
 * is open: the blocks' order, the text of each block a thread is on, the
 * words of each thread on words. One subscription for the page, whoever
 * shows its threads (the page's discussion, the popover at a block, the
 * Discussions list, the pane): read in one walk of the text (words.ts), once
 * a frame at most as it changes, and not at all while no open thread is on
 * the text (`wanted`).
 */
export function useReadThreads(docId: string, editor: EditorHandle | undefined, wanted: boolean) {
  const comments = useDocComments(docId);
  const roots = comments.filter((c) => !c.parent_id);
  const blocks = [...new Set(roots.flatMap((c) => (c.subject_type === "doc_block" ? [c.subject_id] : [])))].join(" ");
  const threads = roots.flatMap((c) => (onWords(c) ? [c.id] : [])).join(" ");
  useEffect(() => {
    if (!editor || !wanted) return;
    const asked = { blocks: blocks.split(" ").filter(Boolean), threads: threads.split(" ").filter(Boolean) };
    const read = () =>
      useThreadReadings.setState((s) => ({
        byPage: { ...s.byPage, [docId]: editor.read(asked.blocks, asked.threads) },
      }));
    read();
    let frame = 0;
    const stop = editor.onChange(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [docId, editor, wanted, blocks, threads]);
}

const NOT_READ: ThreadReading = { order: [], texts: new Map(), words: new Map() };

/**
 * The page's threads, open and resolved, in the order the page reads (the
 * page's own last), each with what it is about and where it is, as the
 * page's text was last read (useReadThreads). `read` is false until it has
 * been, and no block is called gone before.
 */
export function usePageThreads(docId: string): { open: PageThread[]; resolved: PageThread[]; read: boolean } {
  const comments = useDocComments(docId);
  const reading = useThreadReadings((s) => s.byPage[docId]);
  const page = reading ?? NOT_READ;
  return useMemo(() => {
    const { order, texts, words } = page;
    // A block not read yet is not called gone.
    const gone = (blockId: string) => texts.has(blockId) && texts.get(blockId) === undefined;
    const place = new Map(order.map((id, i) => [id, i]));
    const rank = (th: ThreadData) => (th.blockId ? (place.get(th.blockId) ?? order.length) : order.length + 1);
    const all = threadsOf(comments)
      .sort((a, b) => rank(a) - rank(b) || a.root.created_at - b.root.created_at)
      .map((th): PageThread => {
        const { root, blockId } = th;
        if (root.quote && root.detached_at) return { ...th, about: { on: "removed", text: root.quote } };
        if (root.quote) {
          // The words as they read now; the words it was started on until the editor has them.
          const now = words.get(root.id);
          return {
            ...th,
            about: { on: "text", text: now ?? root.quote },
            at: now === undefined ? undefined : { words: root.id },
          };
        }
        if (!blockId) return { ...th, about: { on: "page" } };
        if (gone(blockId)) return { ...th, about: { on: "gone" } };
        return { ...th, about: { on: "text", text: texts.get(blockId) }, at: { block: blockId } };
      });
    return {
      open: all.filter((th) => !th.root.resolved_at),
      resolved: all.filter((th) => th.root.resolved_at),
      read: !!reading,
    };
  }, [comments, page, reading]);
}

/** The words or block text a thread is about, for its label; undefined for the page, or a block gone. */
export const aboutText = (about: About): string | undefined =>
  about.on === "text" || about.on === "removed" ? about.text : undefined;

/** When a thread was last written in: its last reply, or its first comment (milliseconds). */
export const lastActivity = ({ root, replies }: ThreadData) =>
  Math.max(root.created_at, ...replies.map((r) => r.created_at));

/**
 * Brings a thread into view where the page shows it: its words or its block
 * in the text (scrolled to the middle and flashed), or its card in the
 * page's discussion under the title.
 */
export function showInPage({ root, at }: PageThread, editor: EditorHandle | null) {
  if (at && "words" in at) editor?.scrollToThread(at.words);
  else if (at) editor?.scrollToBlock(at.block);
  else
    document
      .querySelector(`[data-page-discussion] [data-thread="${CSS.escape(root.id)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
}

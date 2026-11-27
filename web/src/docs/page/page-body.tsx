// A page from its title down: icon and title, a row's properties, the note
// on pages that cannot be edited here, then the editor and the tasks the
// page points at and that point at it (or, for a database, its views). Its
// comments are where they belong, as in Notion: the page's own discussion
// under the title; threads on its text as cards in a margin level with their
// words where there is room for one, else behind a mark at the end of their
// block that opens them in a popover (a sheet on a phone); and every thread
// in the comments pane, when asked for.

import { GitBranch, Sparkles } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useRef, useState } from "react";
import { useCan } from "@/data/access";
import { useReadWhenSeen } from "@/data/inbox-read";
import { overlayOpen, useHotkeys } from "@/hooks/hotkeys";
import { useAtLeast } from "@/hooks/use-at-least";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { BlockThreads } from "@/docs/comments/block-threads";
import { Margin } from "@/docs/comments/margin";
import { PageDiscussion } from "@/docs/comments/page-discussion";
import { CommentsPanel } from "@/docs/comments/panel";
import { useOpenThreads, useReadThreads } from "@/docs/comments/threads";
import type { EditorHandle } from "@/docs/editor/editor";
import type { Words } from "@/docs/editor/words";
import { PageCover } from "@/docs/page/cover";
import { pageUi, usePageUi } from "@/docs/page/state";
import { PageTitle } from "@/docs/page/title";
import { usePage } from "@/docs/page/use-page";
import { TasksPanel } from "@/docs/page/tasks-panel";
import { usePresence } from "@/docs/page/use-presence";
import { useDocsStore } from "@/docs/store";
import type { Doc } from "@/types/docs";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

const Editor = lazy(() => import("@/docs/editor/editor"));
const DatabaseView = lazy(() => import("@/docs/db/database-page"));
const RowProperties = lazy(() => import("@/docs/db/row-properties").then((m) => ({ default: m.RowProperties })));

interface Props {
  doc: Doc;
  /** Narrow margins, a smaller title, no cover and no margin of comments: for the side peek of a database row. */
  compact?: boolean;
}

const NO_OTHERS: never[] = [];

/**
 * How wide the page must be for a margin of comments beside its text: the
 * text column at its narrowest (40rem, padding included: some 70
 * characters a line, still easy to read), the cards (16rem, laid over the
 * last 1rem of the column's right padding) and a gutter after them (1rem).
 * As Notion does, a page with threads beside it gives up some of its
 * width for them, down to that narrowest; a page without keeps all of it
 * (52rem). Measured on the page itself, not the window: the sidebar, the
 * tree of pages and the comments column take their share of the window
 * first. The column's width follows from the room by CSS alone, so it
 * changes as the window is resized, never as the page is typed in.
 */
const ROOM_FOR_MARGIN_REM = 40 + 16 - 1 + 1;

/** A page's title, icon, properties (for a row) and its editor. */
export function PageBody({ doc, compact }: Props) {
  const page = usePage(doc.id);
  const source = useDocsStore((s) => s.meta[doc.id]?.source);
  const others = useDocsStore((s) => s.presence[doc.id]) ?? NO_OTHERS;
  const commentsOpen = usePageUi((s) => s.commentsOpen) && !compact;
  const litThread = usePageUi((s) => s.litThread);
  const focusThread = usePageUi((s) => s.focusThread);
  const drafting = usePageUi((s) => !!s.draftBlock);
  // Whether the margin has a card to show, once measured: threads whose blocks are gone take no room.
  const [cards, setCards] = useState(true);
  const editor = usePageUi((s) => s.editors[doc.id]);
  // The page's editor known by the page's id, whoever shows its threads: the page shown, or a row's side peek.
  const handle = useCallback((h: EditorHandle | null) => pageUi.setEditor(doc.id, h), [doc.id]);
  const comment = useCallback((blockId: string, words?: Words) => pageUi.startThread(doc.id, blockId, words), [doc.id]);
  const threads = useOpenThreads(doc.id);
  // Read once for all that show this page's threads, and only while one is on its text.
  useReadThreads(doc.id, editor, threads.inText > 0);
  const scroller = useRef<HTMLDivElement>(null);
  const textColumn = useRef<HTMLDivElement>(null);
  const [block, setBlock] = useState<string | null>(null);
  const isDatabase = doc.kind === "database";
  const mirrorsReadOnly = !!source && source.authority === "repo" && source.write_mode === "none";
  // A page of no project is the workspace's: edit() with none.
  const mayEdit = useCan().edit(doc.project_id);
  const readOnly = !!doc.generated || mirrorsReadOnly || !!doc.deleted_at || !mayEdit;
  const headReadOnly = !!doc.generated || !!doc.deleted_at || !mayEdit;
  // A row's side peek has no margin: its threads open from their marks, as on a narrow window.
  const roomy = useAtLeast(scroller, ROOM_FOR_MARGIN_REM, 1) && !compact;
  const margin = roomy && !isDatabase && page.status === "ready" && (threads.inText > 0 || (drafting && mayEdit));
  const beside = margin && cards;

  usePresence(doc.id, block, page.status === "ready" && !isDatabase);
  // Loaded and looked at for a moment, its inbox items are read.
  useReadWhenSeen({ docId: doc.id, ready: page.status === "ready" && !doc.deleted_at });
  useHotkeys(
    {
      // Ctrl+M on every system, as on a task: the command key with M is the Mac's own (it puts the window away).
      "mod+m": (e) => {
        // The task panel over the page has Ctrl+M for the task's own comment box.
        if (!e.ctrlKey || e.metaKey || overlayOpen() || document.querySelector("[data-task-panel]")) return;
        e.preventDefault();
        // Already writing in a comment box (or any other field outside the text): it is left alone.
        if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
        // Asked of the editor, not of `block`: that is the caret as of the last render, and a key pressed
        // right after the caret moved would comment on the block it left. Words selected are what a
        // thread is on, as with the toolbar's Comment, in a page that cannot be edited too.
        const words = editor?.selectedWords();
        const at = words?.block ?? editor?.caretBlock() ?? null;
        if (at && mayEdit && !isDatabase) pageUi.startThread(doc.id, at, words);
        else pageUi.commentOnPage(doc.id);
      },
    },
    { enabled: !compact },
  );

  const focusText = () => document.querySelector<HTMLElement>(`[data-page="${doc.id}"] .bn-editor`)?.focus();

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto" data-page={doc.id}>
        {!compact && <PageCover doc={doc} readOnly={headReadOnly} />}
        <div
          data-margin={beside || undefined}
          className={cx(
            "mx-auto flex w-full",
            // Beside the margin, the text column takes what the cards leave, up to its usual 52rem.
            isDatabase ? "max-w-none" : beside ? "max-w-[68rem]" : "max-w-[52rem]",
          )}
        >
          <div ref={textColumn} className="min-w-0 flex-1">
            <div className={cx("group/top", compact ? "px-4" : isDatabase ? "px-4 sm:px-8" : "px-4 sm:px-12")}>
              <PageTitle doc={doc} readOnly={headReadOnly} compact={compact} onEnter={focusText} />
              {doc.kind === "row" && (
                <Suspense fallback={null}>
                  <RowProperties row={doc} readOnly={headReadOnly} />
                </Suspense>
              )}
              {doc.generated && <Note icon={<Sparkles />}>{t("docs.readOnly.generated")}</Note>}
              {mirrorsReadOnly && <Note icon={<GitBranch />}>{t("docs.readOnly.source")}</Note>}
              {!doc.deleted_at && (
                <PageDiscussion
                  docId={doc.id}
                  projectId={doc.project_id}
                  className="opacity-0 group-focus-within/top:opacity-100 group-hover/top:opacity-100"
                />
              )}
            </div>
            {page.status === "error" ? (
              <EmptyState title={t("docs.loadFailed")} hint={page.error} />
            ) : page.status === "loading" ? (
              <div className="h-40">
                <Loading />
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="h-40">
                    <Loading />
                  </div>
                }
              >
                {isDatabase ? (
                  <DatabaseView doc={doc} readOnly={headReadOnly} />
                ) : (
                  <div
                    className={cx(
                      "pt-2 pb-40",
                      compact && "[&_.qd-editor]:[--qd-pad-end:2.25rem] [&_.qd-editor]:[--qd-pad-start:1rem]",
                    )}
                  >
                    <Editor
                      key={doc.id}
                      docId={doc.id}
                      rows={page.blocks}
                      seq={page.seq}
                      readOnly={readOnly}
                      handle={handle}
                      others={others}
                      threads={threads.perBlock}
                      // Beside the text, each thread's card shows where it is: no counts.
                      countThreads={!margin}
                      onFocusBlock={setBlock}
                      onSaveState={(state) => pageUi.setSaving(doc.id, state)}
                      onComment={mayEdit ? comment : undefined}
                      onOpenThread={pageUi.showThread}
                      wordThreads={threads.onWords}
                      litThread={litThread}
                      activeThread={focusThread}
                      onShowThread={pageUi.showWordsThread}
                      onLightThread={pageUi.lightThread}
                    />
                    {!compact && (
                      <div className="px-4 sm:px-12">
                        <TasksPanel docId={doc.id} />
                      </div>
                    )}
                  </div>
                )}
              </Suspense>
            )}
          </div>
          {margin ? (
            <Margin
              docId={doc.id}
              projectId={doc.project_id}
              text={textColumn}
              onCards={setCards}
              className={beside ? "-ml-4 mr-4 w-64 shrink-0" : "w-0"}
            />
          ) : (
            !roomy && !isDatabase && <BlockThreads docId={doc.id} projectId={doc.project_id} text={textColumn} />
          )}
        </div>
      </div>
      {commentsOpen && <CommentsPanel docId={doc.id} projectId={doc.project_id} />}
    </div>
  );
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-3">
      {icon}
      <span>{children}</span>
    </p>
  );
}

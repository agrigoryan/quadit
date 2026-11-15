// A page from its title down: icon and title, a row's properties, the note
// on pages that cannot be edited here, then the editor (or, for a database,
// its views), with the comments column beside it.

import { GitBranch, Sparkles } from "lucide-react";
import { lazy, type ReactNode, Suspense, useRef, useState } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { CommentsPanel, useOpenThreads } from "@/docs/comments/panel";
import type { EditorHandle } from "@/docs/editor/editor";
import { PageCover } from "@/docs/page/cover";
import { pageUi, usePageUi } from "@/docs/page/state";
import { PageTitle } from "@/docs/page/title";
import { usePage } from "@/docs/page/use-page";
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
  /** Narrow margins, a smaller title and no comments column: for the side peek of a database row. */
  compact?: boolean;
}

const NO_OTHERS: never[] = [];

/** A page's title, icon, properties (for a row) and its editor. */
export function PageBody({ doc, compact }: Props) {
  const page = usePage(doc.id);
  const source = useDocsStore((s) => s.meta[doc.id]?.source);
  const others = useDocsStore((s) => s.presence[doc.id]) ?? NO_OTHERS;
  const commentsOpen = usePageUi((s) => s.commentsOpen) && !compact;
  const threads = useOpenThreads(doc.id);
  const editor = useRef<EditorHandle | null>(null);
  const [block, setBlock] = useState<string | null>(null);
  const isDatabase = doc.kind === "database";
  const mirrorsReadOnly = !!source && source.authority === "repo" && source.write_mode === "none";
  // A page of no project is the workspace's: edit() with none.
  const mayEdit = useCan().edit(doc.project_id);
  const readOnly = !!doc.generated || mirrorsReadOnly || !!doc.deleted_at || !mayEdit;
  const headReadOnly = !!doc.generated || !!doc.deleted_at || !mayEdit;

  usePresence(doc.id, block, page.status === "ready" && !isDatabase);

  const focusText = () => document.querySelector<HTMLElement>(`[data-page="${doc.id}"] .bn-editor`)?.focus();

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto" data-page={doc.id}>
        {!compact && <PageCover doc={doc} readOnly={headReadOnly} />}
        <div className={cx("mx-auto w-full", isDatabase ? "max-w-none" : "max-w-[52rem]")}>
          <div className={cx(compact ? "px-4" : isDatabase ? "px-4 sm:px-8" : "px-4 sm:px-12")}>
            <PageTitle doc={doc} readOnly={headReadOnly} compact={compact} onEnter={focusText} />
            {doc.kind === "row" && (
              <Suspense fallback={null}>
                <RowProperties row={doc} readOnly={headReadOnly} />
              </Suspense>
            )}
            {doc.generated && <Note icon={<Sparkles />}>{t("docs.readOnly.generated")}</Note>}
            {mirrorsReadOnly && <Note icon={<GitBranch />}>{t("docs.readOnly.source")}</Note>}
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
                <div className={cx("pt-2 pb-40", compact && "[&_.bn-editor]:!px-4")}>
                  <Editor
                    key={doc.id}
                    docId={doc.id}
                    rows={page.blocks}
                    seq={page.seq}
                    readOnly={readOnly}
                    handle={editor}
                    others={others}
                    threads={compact ? undefined : threads.perBlock}
                    onFocusBlock={setBlock}
                    onSaveState={(state) => pageUi.setSaving(doc.id, state)}
                    onComment={compact || !mayEdit ? undefined : pageUi.startThread}
                    onOpenThread={pageUi.showThread}
                  />
                </div>
              )}
            </Suspense>
          )}
        </div>
      </div>
      {commentsOpen && (
        <CommentsPanel docId={doc.id} projectId={doc.project_id} editor={editor} pageOnly={isDatabase} />
      )}
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

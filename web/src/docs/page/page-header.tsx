// The bar above a page: where it is in the tree, who else is in it,
// whether edits are saved, comments, sharing and everything else to do
// with the page as a whole.

import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { useOpenThreads } from "@/docs/comments/panel";
import { docTitle, pathTo, useDocs } from "@/docs/data";
import { tintOf } from "@/docs/presence-tint";
import { PageMenu } from "@/docs/page/page-menu";
import { SharePopover } from "@/docs/page/share-popover";
import { pageUi, usePageUi } from "@/docs/page/state";
import { useDocsStore } from "@/docs/store";
import type { Doc } from "@/docs/types";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Tooltip } from "@/ui/tooltip";

const NO_OTHERS: never[] = [];

export function PageHeader({ doc }: { doc: Doc }) {
  const slug = useSlug();
  const docs = useDocs();
  const members = useCollection("members");
  const path = pathTo(docs, doc.id);
  const others = useDocsStore((s) => s.presence[doc.id]) ?? NO_OTHERS;
  const saving = usePageUi((s) => s.saving[doc.id]);
  const commentsOpen = usePageUi((s) => s.commentsOpen);
  const threads = useOpenThreads(doc.id);
  const parent = path[path.length - 1];

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-2 sm:pl-4">
      <Link
        to={parent ? `/${slug}/docs/${parent.id}` : `/${slug}/docs`}
        aria-label={t("docs.header.back")}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink lg:hidden"
      >
        <ChevronLeft className="size-4" />
      </Link>
      <nav aria-label={t("docs.header.path")} className="flex min-w-0 flex-1 items-center gap-0.5 text-sm text-ink-2">
        <Link to={`/${slug}/docs`} className="shrink-0 rounded-sm px-1 hover:bg-hover hover:text-ink max-lg:hidden">
          {t("docs.title")}
        </Link>
        {path.slice(-3).map((p) => (
          <Fragment key={p.id}>
            <ChevronRight className="size-3.5 shrink-0 text-ink-3 max-lg:hidden" />
            <Link to={`/${slug}/docs/${p.id}`} className="max-w-40 truncate rounded-sm px-1 hover:bg-hover hover:text-ink max-lg:hidden">
              {docTitle(p)}
            </Link>
          </Fragment>
        ))}
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 max-lg:hidden" />
        <span className="min-w-0 truncate px-1 font-medium text-ink">{docTitle(doc)}</span>
        {saving && (
          <span className={cx("ml-1 shrink-0 text-xs", saving === "saving" ? "text-ink-2" : "text-ink-3")} aria-live="polite">
            {t(saving === "saving" ? "docs.header.saving" : "docs.header.saved")}
          </span>
        )}
      </nav>

      {others.length > 0 && (
        <div className="flex shrink-0 items-center -space-x-1" aria-label={t("docs.header.others", { n: others.length })}>
          {others.slice(0, 4).map((o) => (
            <Tooltip key={o.user_id} label={t("docs.header.here", { name: members[o.user_id]?.name ?? t("common.someone") })}>
              <span className="rounded-full bg-surface p-px ring-2" style={{ "--tw-ring-color": tintOf(o.user_id) } as React.CSSProperties}>
                <Avatar member={members[o.user_id]} size="sm" />
              </span>
            </Tooltip>
          ))}
          {others.length > 4 && <span className="pl-2 text-xs text-ink-3">+{others.length - 4}</span>}
        </div>
      )}

      <Button variant="ghost" aria-pressed={commentsOpen} onClick={pageUi.toggleComments} className={cx("gap-1 px-2", commentsOpen && "bg-hover text-ink")}>
        <MessageSquare className="size-4" />
        <span className="max-sm:hidden">{t("docs.comment.title")}</span>
        {threads.total > 0 && <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-move px-1 text-2xs font-semibold text-move-ink tnum">{threads.total}</span>}
      </Button>
      {doc.kind !== "row" && !doc.memory_of && <SharePopover doc={doc} />}
      <PageMenu doc={doc} />
    </header>
  );
}

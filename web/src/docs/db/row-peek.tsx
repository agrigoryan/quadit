import { lazy, Suspense, useEffect } from "react";
import { ChevronsRight, Maximize2, Trash2 } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useRow, useSlug } from "@/data/selectors";
import { trashDoc } from "@/docs/actions";
import { docTitle } from "@/docs/data";
import { IconButton } from "@/ui/button";
import { Loading } from "@/ui/spinner";
import { Tooltip } from "@/ui/tooltip";
import { docPath } from "@/docs/area";

// The page body brings the editor with it: fetched when a row is first opened.
const PageBody = lazy(() => import("@/docs/page/page-body").then((m) => ({ default: m.PageBody })));

/**
 * A row opened beside its database: its page, properties and all, in a
 * panel at the right (the whole screen on a phone). The database stays in
 * reach behind it. Escape closes it, unless the caret is in the page's text.
 */
export function RowPeek({ rowId, onClose, readOnly }: { rowId: string; onClose: () => void; readOnly: boolean }) {
  const row = useRow("docs", rowId);
  const slug = useSlug();
  const gone = !row;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!row || gone) return null;

  return (
    <RDialog.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          data-row-peek
          // Not modal: the page's keys (C, ?, G then a letter) go on working beside it.
          data-beside
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            const el = document.activeElement as HTMLElement | null;
            if (el?.isContentEditable) e.preventDefault();
          }}
          className="fixed inset-y-0 right-0 z-40 flex w-[min(46rem,100vw)] flex-col bg-surface shadow-panel outline-none animate-panel max-md:inset-0 max-md:w-auto"
        >
          <VisuallyHidden.Root>
            <RDialog.Title>{docTitle(row)}</RDialog.Title>
          </VisuallyHidden.Root>
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
            <IconButton label={t("db.peek.close")} hint="Esc" onClick={onClose}>
              <ChevronsRight className="size-4" />
            </IconButton>
            <Tooltip label={t("db.row.page")}>
              <Link
                to={docPath(slug, row.id)}
                aria-label={t("db.row.page")}
                className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
              >
                <Maximize2 className="size-3.5" aria-hidden />
              </Link>
            </Tooltip>
            <span className="flex-1" />
            {!readOnly && (
              <IconButton
                label={t("db.row.delete")}
                onClick={() => {
                  trashDoc(row.id);
                  onClose();
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <Suspense fallback={<Loading />}>
              <PageBody key={row.id} doc={row} compact />
            </Suspense>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

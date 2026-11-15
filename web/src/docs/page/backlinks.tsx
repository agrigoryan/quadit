import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import { useRestLoaded } from "@/lib/store";
import { docTitle, useDocs } from "@/docs/data";
import { openDoc, openTask } from "@/docs/nav";
import { PageIcon } from "@/docs/page-icon";
import { useDocsStore } from "@/docs/store";
import { Dialog } from "@/ui/dialog";
import { StatusIcon } from "@/ui/icons";

const NONE: never[] = [];

export interface Backlink {
  kind: "task" | "doc";
  id: string;
  /** Where in a task the mention is, when it is not in the task's own text. */
  where?: "comment" | "decision";
}

/** The tasks and pages that mention a page, each once: a task is named whether its text, a comment or a decision on it does. */
export function useBacklinks(docId: string): Backlink[] {
  const refs = useDocsStore((s) => s.meta[docId]?.mentioned_in) ?? NONE;
  return useMemo(() => {
    const seen = new Map<string, Backlink>();
    for (const ref of refs) {
      const kind = ref.from_scope_type === "task" ? "task" : ref.from_scope_type === "doc" ? "doc" : null;
      if (!kind || ref.from_scope_id === docId) continue;
      const where =
        kind === "task" && (ref.from_type === "comment" || ref.from_type === "decision") ? ref.from_type : undefined;
      const had = seen.get(ref.from_scope_id);
      // The task's own text mentioning the page says more than a comment on it doing so.
      if (!had) seen.set(ref.from_scope_id, { kind, id: ref.from_scope_id, where });
      else if (!where) had.where = undefined;
    }
    return [...seen.values()];
  }, [refs, docId]);
}

export function BacklinksDialog({ docId, open, onClose }: { docId: string; open: boolean; onClose: () => void }) {
  const links = useBacklinks(docId);
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const restLoaded = useRestLoaded();
  const docs = useDocs();
  const row = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-hover";
  // A task that is not in the copy: finished and still on its way, or in a project this person cannot see.
  const unknown = links.filter((l) => l.kind === "task" && !tasks[l.id]).length;
  const shown = links.filter((l) =>
    l.kind === "task" ? !!tasks[l.id] && !tasks[l.id]?.deleted_at : !!docs[l.id] && !docs[l.id]?.deleted_at,
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t("docs.backlinks.title")} size="sm">
      {shown.length === 0 && unknown === 0 ? (
        <p className="py-4 text-center text-sm text-ink-3">{t("docs.backlinks.none")}</p>
      ) : (
        <ul className="-mx-2">
          {shown.map((link) => {
            if (link.kind === "task") {
              const task = tasks[link.id];
              if (!task) return null;
              return (
                <li key={link.id}>
                  <button
                    type="button"
                    className={row}
                    onClick={() => {
                      onClose();
                      openTask(task.key);
                    }}
                  >
                    <StatusIcon category={statuses[task.status_id]?.category ?? "backlog"} />
                    <span className="shrink-0 text-xs font-medium text-ink-2 tnum">{task.key}</span>
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    {link.where && (
                      <span className="shrink-0 text-xs text-ink-3">
                        {t(link.where === "comment" ? "docs.backlinks.inComment" : "docs.backlinks.inDecision")}
                      </span>
                    )}
                  </button>
                </li>
              );
            }
            const doc = docs[link.id];
            if (!doc) return null;
            return (
              <li key={link.id}>
                <button
                  type="button"
                  className={row}
                  onClick={() => {
                    onClose();
                    openDoc(doc.id);
                  }}
                >
                  <PageIcon doc={doc} />
                  <span className="min-w-0 flex-1 truncate">{docTitle(doc)}</span>
                </button>
              </li>
            );
          })}
          {unknown > 0 && (
            <li className="px-2 py-1.5 text-xs text-ink-3">
              {restLoaded ? t("docs.backlinks.hidden", { n: unknown }) : t("docs.backlinks.loading")}
            </li>
          )}
        </ul>
      )}
    </Dialog>
  );
}

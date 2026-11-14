import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import { docTitle, useDocs } from "@/docs/data";
import { openDoc, openTask } from "@/docs/nav";
import { PageIcon } from "@/docs/page-icon";
import { useDocsStore } from "@/docs/store";
import { Dialog } from "@/ui/dialog";
import { StatusIcon } from "@/ui/icons";

const NONE: never[] = [];

/** The tasks and pages that mention a page, each once. */
export function useBacklinks(docId: string): { kind: "task" | "doc"; id: string }[] {
  const refs = useDocsStore((s) => s.meta[docId]?.mentioned_in) ?? NONE;
  return useMemo(() => {
    const seen = new Set<string>();
    const out: { kind: "task" | "doc"; id: string }[] = [];
    for (const ref of refs) {
      const kind = ref.from_scope_type === "task" ? "task" : ref.from_scope_type === "doc" ? "doc" : null;
      if (!kind || ref.from_scope_id === docId || seen.has(ref.from_scope_id)) continue;
      seen.add(ref.from_scope_id);
      out.push({ kind, id: ref.from_scope_id });
    }
    return out;
  }, [refs, docId]);
}

export function BacklinksDialog({ docId, open, onClose }: { docId: string; open: boolean; onClose: () => void }) {
  const links = useBacklinks(docId);
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const docs = useDocs();
  const row = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-hover";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t("docs.backlinks.title")} size="sm">
      {links.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-3">{t("docs.backlinks.none")}</p>
      ) : (
        <ul className="-mx-2">
          {links.map((link) => {
            if (link.kind === "task") {
              const task = tasks[link.id];
              if (!task) return null;
              return (
                <li key={link.id}>
                  <button type="button" className={row} onClick={() => (onClose(), openTask(task.key))}>
                    <StatusIcon category={statuses[task.status_id]?.category ?? "backlog"} />
                    <span className="shrink-0 text-xs font-medium text-ink-2 tnum">{task.key}</span>
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  </button>
                </li>
              );
            }
            const doc = docs[link.id];
            if (!doc || doc.deleted_at) return null;
            return (
              <li key={link.id}>
                <button type="button" className={row} onClick={() => (onClose(), openDoc(doc.id))}>
                  <PageIcon doc={doc} />
                  <span className="min-w-0 flex-1 truncate">{docTitle(doc)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

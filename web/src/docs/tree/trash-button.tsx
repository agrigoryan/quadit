import { Trash2, Undo2 } from "lucide-react";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";

import { restoreDoc } from "@/docs/actions";
import { docTitle } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { loadTrash, useTrashed } from "@/docs/trash";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Ago } from "@/ui/ago";

/** The trash for pages: what was deleted, each with a way back. In a project's Docs, that project's deleted pages. */
export function TrashButton({ projectId }: { projectId?: string }) {
  const trashed = useTrashed(projectId);
  const can = useCan();
  return (
    <Popover onOpenChange={(open) => open && void loadTrash()}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-ink-2 hover:bg-press/60 hover:text-ink data-[state=open]:bg-press"
        >
          <Trash2 className="size-4 text-ink-3" />
          <span className="flex-1 text-left">{t("docs.trash.title")}</span>
          {trashed.length > 0 && <span className="text-xs text-ink-3 tnum">{trashed.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" aria-label={t("docs.trash.title")} className="w-72 p-1">
        {trashed.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-3">{t("docs.trash.empty")}</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {trashed.map((item) => (
              <li key={item.id} className="flex h-8 items-center gap-2 rounded-sm px-2 text-sm hover:bg-hover">
                <PageIcon doc={{ icon: item.icon, kind: item.kind as "page" }} />
                <span className="min-w-0 flex-1 truncate">{docTitle(item)}</span>
                <span className="shrink-0 text-xs text-ink-3">
                  <Ago ms={item.deleted_at} />
                </span>
                {can.edit(item.project_id) && (
                  <button
                    type="button"
                    aria-label={t("docs.trash.restore")}
                    title={t("docs.trash.restore")}
                    onClick={() => restoreDoc(item.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-2 hover:bg-press hover:text-ink"
                  >
                    <Undo2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-3 py-2 text-xs text-ink-3">{t("docs.trash.note")}</p>
      </PopoverContent>
    </Popover>
  );
}

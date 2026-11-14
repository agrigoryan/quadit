import { Trash2, Undo2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { ago } from "@/lib/time";
import { restoreDoc } from "@/docs/actions";
import { docTitle } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { useTrashed } from "@/docs/trash";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** The trash for pages: what was deleted, each with a way back. */
export function TrashButton() {
  const trashed = useTrashed();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-ink-2 hover:bg-press/60 hover:text-ink data-[state=open]:bg-press">
          <Trash2 className="size-4 text-ink-3" />
          <span className="flex-1 text-left">{t("docs.trash.title")}</span>
          {trashed.length > 0 && <span className="text-xs text-ink-3 tnum">{trashed.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-1">
        {trashed.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-3">{t("docs.trash.empty")}</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {trashed.map((item) => (
              <li key={item.id} className="flex h-8 items-center gap-2 rounded-sm px-2 text-sm hover:bg-hover">
                <PageIcon doc={{ icon: item.icon, kind: item.kind as "page" }} />
                <span className="min-w-0 flex-1 truncate">{docTitle(item)}</span>
                <span className="shrink-0 text-xs text-ink-3">{ago(item.deleted_at)}</span>
                <button
                  type="button"
                  aria-label={t("docs.trash.restore")}
                  title={t("docs.trash.restore")}
                  onClick={() => restoreDoc(item.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-2 hover:bg-press hover:text-ink"
                >
                  <Undo2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-3 py-2 text-xs text-ink-3">{t("docs.trash.note")}</p>
      </PopoverContent>
    </Popover>
  );
}

// The List / Board / Timeline switch, as it looks at the top of a project's
// tasks: the timeline is the third way to lay the same work out.

import { ChartGantt, ListTodo, SquareKanban } from "lucide-react";
import { useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/data/selectors";

const layouts = [
  { id: "tasks", icon: ListTodo, label: () => t("list.layout.list") },
  { id: "board", icon: SquareKanban, label: () => t("list.layout.board") },
  { id: "timeline", icon: ChartGantt, label: () => t("nav.timeline") },
] as const;

export function LayoutTabs({ projectKey }: { projectKey: string }) {
  const slug = useSlug();
  const navigate = useNavigate();
  return (
    <div role="tablist" aria-label={t("list.layout")} className="flex shrink-0 items-center rounded-md bg-sunken p-0.5">
      {layouts.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === "timeline"}
          onClick={() => id !== "timeline" && navigate(`/${slug}/p/${projectKey}/${id}`)}
          className={cx(
            "flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
            id === "timeline" ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">{label()}</span>
        </button>
      ))}
    </div>
  );
}

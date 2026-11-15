// The tabs at the start of a task page's toolbar that switch between the
// list and the board, and on a project's page lead to its timeline.

import { ChartGantt, ListTodo, SquareKanban } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/data/selectors";
import type { Project } from "@/types/core";

const layouts = [
  { id: "list", icon: ListTodo, label: () => t("list.layout.list") },
  { id: "board", icon: SquareKanban, label: () => t("list.layout.board") },
] as const;

interface Props {
  layout: "list" | "board";
  /** Set on a project's page, which takes its layout from the address; a view keeps it in its state. */
  routeProject: Project | undefined;
  onChange: (layout: "list" | "board") => void;
}

export function LayoutTabs({ layout, routeProject, onChange }: Props) {
  const slug = useSlug();
  const navigate = useNavigate();
  const location = useLocation();

  function choose(next: "list" | "board") {
    if (routeProject)
      void navigate(`/${slug}/p/${routeProject.key}/${next === "board" ? "board" : "tasks"}${location.search}`);
    else onChange(next);
  }

  return (
    <div role="tablist" aria-label={t("list.layout")} className="flex shrink-0 items-center rounded-md bg-sunken p-0.5">
      {layouts.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={layout === id}
          onClick={() => choose(id)}
          className={cx(
            "flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
            layout === id ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">{label()}</span>
        </button>
      ))}
      {/* A project's third layout is a page of its own (insights/timeline). */}
      {routeProject && (
        <button
          type="button"
          role="tab"
          aria-selected={false}
          onClick={() => navigate(`/${slug}/p/${routeProject.key}/timeline`)}
          className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-ink-2 hover:text-ink"
        >
          <ChartGantt className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">{t("nav.timeline")}</span>
        </button>
      )}
    </div>
  );
}

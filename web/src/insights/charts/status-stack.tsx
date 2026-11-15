// Tasks by status, one bar per project, split into its statuses. Parts run
// from done to not started, so the bar reads like progress; each part
// prints its count when there is room and says its name on hover or focus.

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Category } from "@/lib/types";
import { Legend, useWidth } from "@/insights/charts/base";
import { count } from "@/insights/lib/format";
import type { StatusCount } from "@/insights/lib/types";
import { Tooltip } from "@/ui/tooltip";

/** The order parts are drawn in, and the colour of each kind of status. */
export const STACK: { category: Category; color: string; ink: string }[] = [
  { category: "done", color: "var(--viz-done)", ink: "var(--viz-on)" },
  { category: "started", color: "var(--viz-started)", ink: "var(--viz-on)" },
  { category: "waiting", color: "var(--viz-waiting)", ink: "var(--viz-on)" },
  { category: "unstarted", color: "var(--viz-todo)", ink: "var(--viz-on)" },
  { category: "backlog", color: "var(--viz-backlog)", ink: "var(--viz-on-backlog)" },
];

export const categoryName = (c: Category) => t(`category.${c}` as "category.done");

interface ProjectRow {
  project: string;
  parts: (StatusCount & { color: string; ink: string })[];
  total: number;
  canceled: number;
}

/** The counts grouped by project, parts in drawing order, statuses with no tasks left out. */
export function byProject(rows: StatusCount[]): ProjectRow[] {
  const out = new Map<string, ProjectRow>();
  for (const row of rows) {
    if (!out.has(row.project)) out.set(row.project, { project: row.project, parts: [], total: 0, canceled: 0 });
  }
  for (const look of STACK) {
    for (const row of rows) {
      if (row.category !== look.category || row.count === 0) continue;
      const p = out.get(row.project) as ProjectRow;
      p.parts.push({ ...row, color: look.color, ink: look.ink });
      p.total += row.count;
    }
  }
  for (const row of rows) if (row.category === "canceled") (out.get(row.project) as ProjectRow).canceled += row.count;
  return [...out.values()];
}

function Bar({ row }: { row: ProjectRow }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const summary = row.parts.map((p) => `${p.status} ${count(p.count)}`).join(", ");
  return (
    <div
      ref={box}
      role="group"
      aria-label={t("ins.chart.statusLabel", { project: row.project, summary })}
      className="flex h-7 gap-0.5"
    >
      {row.parts.map((part) => {
        const share = part.count / row.total;
        // The count is printed only where it fits with room to spare, however many digits it has.
        const written = count(part.count);
        const fits = share * width >= Math.max(26, 10 + written.length * 8);
        const tip = t("ins.chart.statusTip", { status: part.status, n: part.count, share: Math.round(share * 100) });
        return (
          <Tooltip key={part.status} label={tip} side="top">
            <span
              tabIndex={0}
              aria-label={tip}
              className="flex h-full min-w-1 items-center rounded-[4px] pl-1.5 text-xs font-semibold tnum outline-offset-2 hover:brightness-110"
              style={{ width: `${share * 100}%`, background: part.color, color: part.ink }}
            >
              {fits && written}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** One labelled bar per project, then the key. `names` gives a project's name for its key. */
export function StatusStack({ rows, names }: { rows: StatusCount[]; names: Record<string, string> }) {
  const projects = byProject(rows);
  const used = new Set(projects.flatMap((p) => p.parts.map((part) => part.category)));
  return (
    <div className="flex flex-col gap-3">
      {projects.map((row) => (
        <div key={row.project}>
          <div className="mb-1 flex items-baseline gap-2 text-xs">
            <span className="min-w-0 truncate font-medium text-ink">{names[row.project] ?? row.project}</span>
            <span className="text-ink-3 tnum">{row.project}</span>
            <span className="flex-1" />
            <span className={cx("shrink-0 text-ink-2 tnum")}>
              {t("ins.chart.taskCount", { n: row.total })}
              {row.canceled > 0 && (
                <span className="text-ink-3">{t("ins.chart.canceledMore", { n: row.canceled })}</span>
              )}
            </span>
          </div>
          {row.total > 0 ? (
            <Bar row={row} />
          ) : (
            <div className="h-7 rounded-[4px] bg-sunken" role="img" aria-label={t("ins.chart.noTasks")} />
          )}
        </div>
      ))}
      <Legend
        series={STACK.filter((s) => used.has(s.category)).map((s) => ({
          name: categoryName(s.category),
          color: s.color,
          mark: "bar",
        }))}
      />
    </div>
  );
}

/** The same numbers as rows, for the table view. */
export function statusRows(rows: StatusCount[]): (string | number)[][] {
  return rows.filter((r) => r.count > 0).map((r) => [`${r.project} ${r.status}`, r.count]);
}

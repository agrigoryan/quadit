// One cycle in full: its dates, the burn-up of scope against done, its
// tasks by status, and a way to carry what is not finished into the next
// cycle.

import { useMemo, useState } from "react";
import { ArrowRight, ChevronLeft } from "lucide-react";
import { Link, useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { statusesOf, useCollection, useCycles, useProjectByKey, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { daysUntil, formatDay, serverDay } from "@/lib/time";
import { type Cycle, isOpenCategory, type Project } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { DataTable, TableSwitch } from "@/insights/charts/base";
import { BurnUp, burnRows } from "@/insights/charts/burn-up";
import { count } from "@/insights/lib/format";
import { useLive } from "@/insights/lib/live";
import type { CycleChart } from "@/insights/lib/types";
import { moveToCycle, updateCycle } from "@/insights/plan/actions";
import { emptyTally, useTallies } from "@/insights/plan/stats";
import { PageBar, Panel } from "@/insights/ui/panel";
import { Progress } from "@/insights/ui/progress";
import { useTasksBy } from "@/pages/plan-parts";
import { NotFoundPage } from "@/shell/placeholders";
import { keyColumn, TaskRow } from "@/tasks/task-row";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";

export const cycleName = (cycle: Cycle) => cycle.name || t("prop.cycleName", { n: String(cycle.number) });

/** Where a cycle stands against today. */
export function cyclePhase(cycle: Cycle, now = serverDay()): "current" | "upcoming" | "past" {
  return cycle.ends_on < now ? "past" : cycle.starts_on > now ? "upcoming" : "current";
}

export function CyclePage() {
  const { key, id } = useParams();
  const project = useProjectByKey(key);
  const cycle = useStore((s) => (id ? s.c.cycles[id] : undefined));
  if (!project || !cycle || cycle.deleted_at || cycle.project_id !== project.id) return <NotFoundPage />;
  return <CycleView project={project} cycle={cycle} />;
}

function CycleView({ project, cycle }: { project: Project; cycle: Cycle }) {
  const name = cycleName(cycle);
  usePageTitle(name);
  const slug = useSlug();
  const statuses = useCollection("statuses");
  const cycles = useCycles(project.id);
  const tasks = useTasksBy(project.id, "cycle_id")[cycle.id] ?? [];
  const tally = useTallies("cycle_id")[cycle.id] ?? emptyTally();
  const phase = cyclePhase(cycle);
  const next = cycles.find((c) => c.starts_on > cycle.ends_on);
  const unfinished = tasks.filter((task) => isOpenCategory(statuses[task.status_id]?.category));
  const groups = useMemo(
    () =>
      statusesOf(statuses, project.id)
        .map((status) => ({ status, tasks: tasks.filter((task) => task.status_id === status.id) }))
        .filter((g) => g.tasks.length > 0),
    [statuses, project.id, tasks],
  );
  const left = daysUntil(cycle.ends_on, serverDay()); // a cycle's days are the server's

  return (
    <div className="flex h-full flex-col">
      <PageBar>
        <Link
          to={`/${slug}/p/${project.key}/cycles`}
          className="flex h-7 items-center gap-1 rounded-md pr-2 pl-1 text-sm text-ink-2 hover:bg-hover hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t("nav.cycles")}
        </Link>
        <span className="flex-1" />
        <Button
          disabled={!next || unfinished.length === 0}
          title={!next ? t("cycle.noNext") : undefined}
          onClick={() => next && moveToCycle(unfinished, next, cycleName(next))}
        >
          <ArrowRight className="size-4" aria-hidden />
          {next && unfinished.length > 0
            ? t("cycle.moveUnfinished", { n: unfinished.length, name: cycleName(next) })
            : t("cycle.moveUnfinishedNone")}
        </Button>
      </PageBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="px-4 pt-4 pb-3 md:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{name}</h1>
            <Badge tone={phase === "current" ? "accent" : "neutral"}>{t(`cycle.phase.${phase}`)}</Badge>
            {phase === "current" && (
              <span className="text-xs text-ink-3 tnum">{t("cycle.daysLeft", { n: left + 1 })}</span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
              {t("cycles.starts")}
              <Input
                type="date"
                required
                value={cycle.starts_on}
                max={cycle.ends_on}
                onChange={(e) =>
                  e.target.value && e.target.value <= cycle.ends_on && updateCycle(cycle, { starts_on: e.target.value })
                }
                className="w-[9rem] tnum"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
              {t("cycles.ends")}
              <Input
                type="date"
                required
                value={cycle.ends_on}
                min={cycle.starts_on}
                onChange={(e) =>
                  e.target.value && e.target.value >= cycle.starts_on && updateCycle(cycle, { ends_on: e.target.value })
                }
                className="w-[9rem] tnum"
              />
            </label>
            <div className="min-w-56 flex-1 pb-1 sm:max-w-md">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs text-ink-2 tnum">
                <span>
                  {t("ins.progress.withStarted", { done: tally.done, started: tally.started, total: tally.total })}
                </span>
                {tally.points > 0 && (
                  <span className="text-ink-3">{t("ins.points", { done: tally.pointsDone, total: tally.points })}</span>
                )}
              </div>
              <Progress done={tally.done} started={tally.started} total={tally.total} />
            </div>
          </div>
        </div>

        <BurnPanel cycle={cycle} hasPoints={tally.points > 0} />

        <div className="border-t border-line" style={keyColumn(groups.flatMap((g) => g.tasks.map((task) => task.key)))}>
          {groups.length === 0 && (
            <p className="px-4 py-3 text-sm text-ink-2 md:px-6">
              {t("cycles.noTasks")} <span className="text-ink-3">{formatDay(cycle.starts_on)}</span>
            </p>
          )}
          {groups.map(({ status, tasks: list }) => (
            <section key={status.id} aria-label={status.name}>
              <h2 className="sticky top-0 z-[2] flex h-8 items-center gap-2 border-b border-line bg-sunken px-3 text-sm font-medium">
                <StatusIcon category={status.category} />
                {status.name}
                <span className="text-xs font-normal text-ink-3 tnum">{count(list.length)}</span>
              </h2>
              {list.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function BurnPanel({ cycle, hasPoints }: { cycle: Cycle; hasPoints: boolean }) {
  const [unit, setUnit] = useState<"tasks" | "points">("tasks");
  const [table, setTable] = useState(false);
  const { data, error, loading, refreshing } = useLive<CycleChart>(`/cycles/${cycle.id}/chart`, {
    only: ["task", "cycle"],
  });
  const shown = hasPoints ? unit : "tasks";
  const units = ["tasks", "points"] as const;
  return (
    <Panel
      title={t("cycle.chart")}
      className="border-t border-line"
      action={
        <span className="flex items-center gap-2">
          {hasPoints && (
            <span
              role="group"
              aria-label={t("cycle.chart.unit")}
              className="flex items-center rounded-md bg-sunken p-0.5"
            >
              {units.map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={shown === u}
                  onClick={() => setUnit(u)}
                  className={cx(
                    "h-6 rounded-sm px-2 text-xs font-medium",
                    shown === u ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {t(`cycle.chart.${u}`)}
                </button>
              ))}
            </span>
          )}
          <TableSwitch on={table} onChange={setTable} />
        </span>
      }
    >
      <div className={cx("max-w-4xl", refreshing && "opacity-70")}>
        {error && !data ? (
          <p role="alert" className="text-sm text-danger">
            {t("ins.loadFailed", { why: error })}
          </p>
        ) : loading || !data ? (
          <div className="flex h-[200px] items-center justify-center">
            <Spinner />
          </div>
        ) : table ? (
          <DataTable
            caption={t("cycle.chart")}
            head={[t("cycle.chart.day"), t("cycle.chart.scope"), t("cycle.chart.done")]}
            rows={burnRows(data.days, shown)}
          />
        ) : (
          <BurnUp days={data.days} unit={shown} today={serverDay()} />
        )}
      </div>
    </Panel>
  );
}

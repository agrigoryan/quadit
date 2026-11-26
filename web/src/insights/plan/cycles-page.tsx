// A project's cycles, as a list of rows, and starting a new one.

import { type FormEvent, useMemo, useState } from "react";
import { Gauge, Plus, RefreshCw } from "lucide-react";
import { useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useCycles, useProjectByKey, useSlug } from "@/data/selectors";
import { useRestLoaded } from "@/data/store";
import { daysUntil, formatDay, serverDay } from "@/lib/time";
import type { Cycle, Project } from "@/types/core";
import { usePageTitle } from "@/lib/ui-state";
import { addDays } from "@/lib/days";
import { createCycle } from "@/insights/plan/actions";
import { cycleName, cyclePhase } from "@/insights/plan/cycle-page";
import { capacityOf, type Tally, useTallies } from "@/insights/plan/stats";
import { PlanRow } from "@/insights/plan/plan-row";
import { useTasksBy } from "@/insights/plan/tasks-by";
import { NotFoundPage } from "@/ui/not-found";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Input } from "@/ui/input";
import { Tooltip } from "@/ui/tooltip";

/** A project's cycles: the stretches of days its work is planned into. */
export function CyclesPage() {
  const project = useProjectByKey(useParams().key);
  return project ? <Cycles project={project} /> : <NotFoundPage />;
}

/** The current cycle, the ones to come (soonest first) and the past (latest first). */
function inGroups(cycles: Cycle[], now: string) {
  return [
    { id: "current" as const, cycles: cycles.filter((c) => cyclePhase(c, now) === "current") },
    {
      id: "upcoming" as const,
      cycles: cycles
        .filter((c) => cyclePhase(c, now) === "upcoming")
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on)),
    },
    {
      id: "past" as const,
      cycles: cycles.filter((c) => cyclePhase(c, now) === "past").sort((a, b) => b.ends_on.localeCompare(a.ends_on)),
    },
  ].filter((g) => g.cycles.length > 0);
}

function Cycles({ project }: { project: Project }) {
  usePageTitle(t("cycles.pageTitle", { project: project.name }));
  const slug = useSlug();
  const cycles = useCycles(project.id);
  const tasksBy = useTasksBy(project.id, "cycle_id");
  const tallies = useTallies("cycle_id");
  const now = serverDay();
  const groups = useMemo(() => inGroups(cycles, now), [cycles, now]);
  const capacity = capacityOf(cycles, tallies, now);
  const [openId, setOpenId] = useState<string | null>(null);
  const readOnly = !useCan().edit(project.id);

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-line py-1.5 pr-2 pl-4">
        <p className="flex-1 text-xs text-ink-2 tnum max-sm:hidden">{t("cycles.count", { n: cycles.length })}</p>
        {!readOnly && <NewCycle project={project} cycles={cycles} />}
      </header>
      {groups.length === 0 ? (
        <EmptyState icon={<RefreshCw />} title={t("cycles.empty")} hint={t("cycles.emptyHint")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-10">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`cycles-${group.id}`}>
              <h2
                id={`cycles-${group.id}`}
                className="flex h-8 items-center gap-2 border-b border-line bg-sunken px-4 text-xs font-medium text-ink-2"
              >
                {t(`cycle.phase.${group.id}`)}
                <span className="font-normal text-ink-3 tnum">{group.cycles.length}</span>
              </h2>
              <ul>
                {group.cycles.map((cycle) => (
                  <PlanRow
                    key={cycle.id}
                    name={cycleName(cycle)}
                    to={`/${slug}/p/${project.key}/cycles/${cycle.id}`}
                    badge={
                      group.id === "current" ? (
                        <Badge tone="accent">
                          {t("cycle.daysLeft", { n: daysUntil(cycle.ends_on, serverDay()) + 1 })}
                        </Badge>
                      ) : undefined
                    }
                    meta={
                      <CycleMeta
                        cycle={cycle}
                        tally={tallies[cycle.id]}
                        estimates={!!project.settings?.estimates}
                        capacity={group.id === "past" ? undefined : capacity}
                      />
                    }
                    tally={tallies[cycle.id]}
                    tasks={tasksBy[cycle.id] ?? []}
                    open={openId === cycle.id}
                    onToggle={() => setOpenId(openId === cycle.id ? null : cycle.id)}
                    emptyText={t("cycles.noTasks")}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface MetaProps {
  cycle: Cycle;
  tally: Tally | undefined;
  /** The project estimates: the counts are in points. */
  estimates: boolean;
  /** What a cycle of the project can hold, for one that has not ended. */
  capacity: ReturnType<typeof capacityOf>;
}

/**
 * The cycle's dates and, where the project estimates, its points; for one
 * not yet ended, its scope against what the project's cycles complete.
 */
function CycleMeta({ cycle, tally, estimates, capacity }: MetaProps) {
  // Points done are not known until the finished tasks have arrived, nor is capacity; the row says it is loading.
  const restLoaded = useRestLoaded();
  return (
    <>
      {restLoaded && capacity ? (
        <Capacity scope={tally?.points ?? 0} capacity={capacity} estimates={estimates} />
      ) : (
        restLoaded &&
        estimates && (
          <span className="shrink-0 text-xs text-ink-3 tnum max-md:hidden">
            {t("ins.points", { done: tally?.pointsDone ?? 0, total: tally?.points ?? 0 })}
          </span>
        )
      )}
      <span className="shrink-0 text-xs text-ink-3 tnum max-sm:hidden">
        {t("cycles.range", { from: formatDay(cycle.starts_on), to: formatDay(cycle.ends_on) })}
      </span>
    </>
  );
}

/** "34 of about 30 points": what is planned against what is done in a cycle, marked when it is more. */
function Capacity({
  scope,
  capacity,
  estimates,
}: {
  scope: number;
  capacity: NonNullable<MetaProps["capacity"]>;
  estimates: boolean;
}) {
  const over = scope > capacity.points;
  const text = t(estimates ? "cycles.capacity.points" : "cycles.capacity.tasks", { scope, n: capacity.points });
  const hint = t("cycles.capacity.hint", { n: capacity.cycles });
  const told = over ? [text, t("cycles.capacity.over"), hint] : [text, hint];
  return (
    <Tooltip label={told.slice(1).join(". ")} side="top">
      <span
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the figure can be stepped to with Tab, to read how it is worked out in the tooltip
        tabIndex={0}
        aria-label={told.join(". ")}
        className={cx(
          "flex shrink-0 items-center gap-1 rounded-sm text-xs tnum outline-offset-2",
          over ? "font-medium text-wait" : "text-ink-3",
        )}
      >
        <Gauge className="size-3" aria-hidden />
        {text}
      </span>
    </Tooltip>
  );
}

function NewCycle({ project, cycles }: { project: Project; cycles: Cycle[] }) {
  const length = project.settings?.cycle_days || 14;
  // The next free stretch: the day after the last cycle ends, or today.
  const lastEnd = cycles.reduce((max, c) => (c.ends_on > max ? c.ends_on : max), "");
  const suggestedStart = lastEnd && lastEnd >= serverDay() ? addDays(lastEnd, 1) : serverDay();
  const [edited, setEdited] = useState<{ start: string; end: string } | null>(null);
  const start = edited?.start ?? suggestedStart;
  const end = edited?.end ?? addDays(suggestedStart, length - 1);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!start || !end) return;
    const number = cycles.reduce((max, c) => Math.max(max, c.number), 0) + 1;
    // Overlapping dates are refused by the server: its message shows as a toast and the dates stay to be fixed.
    createCycle(project.id, number, start, end).then(
      () => setEdited(null),
      () => {},
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 max-sm:flex-1">
      <label className="flex items-center gap-1.5 text-xs text-ink-2">
        {t("cycles.starts")}
        <Input
          type="date"
          required
          value={start}
          onChange={(e) =>
            setEdited({ start: e.target.value, end: e.target.value ? addDays(e.target.value, length - 1) : end })
          }
          className="h-7 w-36 tnum"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-2">
        {t("cycles.ends")}
        <Input
          type="date"
          required
          min={start}
          value={end}
          onChange={(e) => setEdited({ start, end: e.target.value })}
          className="h-7 w-36 tnum"
        />
      </label>
      <Button type="submit" disabled={!start || !end}>
        <Plus className="size-4" aria-hidden />
        {t("cycles.create")}
      </Button>
    </form>
  );
}

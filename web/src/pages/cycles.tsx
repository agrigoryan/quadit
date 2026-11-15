import { type FormEvent, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useParams } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { useCycles, useProjectByKey, useSlug } from "@/lib/selectors";
import { useRestLoaded } from "@/lib/store";
import { daysUntil, formatDay, today } from "@/lib/time";
import type { Cycle, Project } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { addDays } from "@/insights/lib/format";
import { cycleName, cyclePhase } from "@/insights/plan/cycle-page";
import { type Tally, useTallies } from "@/insights/plan/stats";
import { PlanRow, useTasksBy } from "@/pages/plan-parts";
import { NotFoundPage } from "@/shell/placeholders";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Input } from "@/ui/input";

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
      cycles: cycles.filter((c) => cyclePhase(c, now) === "upcoming").sort((a, b) => a.starts_on.localeCompare(b.starts_on)),
    },
    { id: "past" as const, cycles: cycles.filter((c) => cyclePhase(c, now) === "past").sort((a, b) => b.ends_on.localeCompare(a.ends_on)) },
  ].filter((g) => g.cycles.length > 0);
}

function Cycles({ project }: { project: Project }) {
  usePageTitle(t("cycles.pageTitle", { project: project.name }));
  const slug = useSlug();
  const cycles = useCycles(project.id);
  const tasksBy = useTasksBy(project.id, "cycle_id");
  const tallies = useTallies("cycle_id");
  const now = today();
  const groups = useMemo(() => inGroups(cycles, now), [cycles, now]);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-line py-1.5 pr-2 pl-4">
        <p className="flex-1 text-xs text-ink-2 tnum max-sm:hidden">{t("cycles.count", { n: cycles.length })}</p>
        <NewCycle project={project} cycles={cycles} />
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
                        <Badge tone="accent">{t("cycle.daysLeft", { n: daysUntil(cycle.ends_on) + 1 })}</Badge>
                      ) : undefined
                    }
                    meta={<CycleMeta cycle={cycle} tally={tallies[cycle.id]} />}
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

/** The cycle's dates and, when its tasks are estimated, its points. */
function CycleMeta({ cycle, tally }: { cycle: Cycle; tally: Tally | undefined }) {
  // Points done are not known until the finished tasks have arrived; the row says it is loading.
  const restLoaded = useRestLoaded();
  return (
    <>
      {restLoaded && !!tally?.points && (
        <span className="shrink-0 text-xs text-ink-3 tnum max-md:hidden">
          {t("ins.points", { done: tally.pointsDone, total: tally.points })}
        </span>
      )}
      <span className="shrink-0 text-xs text-ink-3 tnum max-sm:hidden">
        {t("cycles.range", { from: formatDay(cycle.starts_on), to: formatDay(cycle.ends_on) })}
      </span>
    </>
  );
}

function NewCycle({ project, cycles }: { project: Project; cycles: Cycle[] }) {
  const length = project.settings?.cycle_days || 14;
  // The next free stretch: the day after the last cycle ends, or today.
  const lastEnd = cycles.reduce((max, c) => (c.ends_on > max ? c.ends_on : max), "");
  const suggestedStart = lastEnd && lastEnd >= today() ? addDays(lastEnd, 1) : today();
  const [edited, setEdited] = useState<{ start: string; end: string } | null>(null);
  const start = edited?.start ?? suggestedStart;
  const end = edited?.end ?? addDays(suggestedStart, length - 1);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!start || !end) return;
    const id = newId();
    const number = cycles.reduce((max, c) => Math.max(max, c.number), 0) + 1;
    // Overlapping dates are refused by the server: its message shows as a toast and the dates stay to be fixed.
    mutate({ type: "cycle.create", args: { id, project: project.id, starts_on: start, ends_on: end } }, (tx) =>
      tx.insert("cycles", { id, project_id: project.id, number, starts_on: start, ends_on: end }),
    ).then(
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
          onChange={(e) => setEdited({ start: e.target.value, end: e.target.value ? addDays(e.target.value, length - 1) : end })}
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

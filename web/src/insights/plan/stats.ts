// Progress of epics, milestones and cycles, counted from the store so it
// moves the moment a task does, and what a project's cycles can hold. The
// rules match the server's dashboard: canceled tasks are left out, a task
// counts the points tasks/estimates.ts says, and "at risk" means the same
// three things.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useArchived, useLookup, useLookupEvenIfGone, useRows } from "@/data/selectors";
import type { Dict } from "@/data/store";
import { daysUntil } from "@/lib/time";
import {
  type Cycle,
  type Epic,
  isCanceledCategory,
  isDoneCategory,
  type Project,
  type Status,
  type Task,
} from "@/types/core";
import { pointsOf } from "@/tasks/estimates";

export interface Tally {
  total: number;
  done: number;
  /** Under way: started or waiting. */
  started: number;
  /** Every task's points (tasks/estimates.ts pointsOf): a task of a project that does not estimate counts 1. */
  points: number;
  pointsDone: number;
  /** One of the tasks counted is in a project that estimates: its points are worth showing. */
  estimated: boolean;
  /** When any of its tasks last changed. */
  lastMove: number;
}

export const emptyTally = (): Tally => ({
  total: 0,
  done: 0,
  started: 0,
  points: 0,
  pointsDone: 0,
  estimated: false,
  lastMove: 0,
});

function addTo(tally: Tally, task: Task, statuses: Dict<Status>, projects: Dict<Project>) {
  const category = statuses[task.status_id]?.category;
  if (isCanceledCategory(category)) return;
  const project = projects[task.project_id];
  const points = pointsOf(task, project);
  tally.estimated ||= !!project?.settings?.estimates;
  tally.total++;
  tally.points += points;
  if (isDoneCategory(category)) {
    tally.done++;
    tally.pointsDone += points;
  } else if (category === "started") tally.started++;
  if (task.updated_at > tally.lastMove) tally.lastMove = task.updated_at;
}

/** `projects` holds the tasks' projects, an archived one too: it still says how its tasks are estimated. */
export function tallyOf(tasks: Task[], statuses: Dict<Status>, projects: Dict<Project>): Tally {
  const out = emptyTally();
  for (const task of tasks) addTo(out, task, statuses, projects);
  return out;
}

/**
 * A tally for every epic, milestone or cycle that has tasks, by its id.
 * Archived tasks count, as on the server's dashboard; trashed ones do not.
 */
export function useTallies(field: "epic_id" | "milestone_id" | "cycle_id"): Dict<Tally> {
  const live = useRows("tasks");
  const archived = useArchived("tasks");
  const statuses = useLookup("statuses");
  const projects = useLookupEvenIfGone("projects");
  return useMemo(() => {
    const out: Dict<Tally> = {};
    for (const task of [...live, ...archived]) {
      const id = task[field];
      if (id) addTo((out[id] ??= emptyTally()), task, statuses, projects);
    }
    return out;
  }, [live, archived, statuses, projects, field]);
}

/** How many of the latest ended cycles capacity is the mean of. */
const CAPACITY_CYCLES = 3;

/**
 * What a project's cycle can hold, about: the mean of the points done (or,
 * where it does not estimate, the tasks done) in its up to three latest
 * cycles that have ended before `today`, not rounded, with how many cycles
 * that was. Undefined while none has ended. `cycles` are the project's; `tallies`
 * are by cycle, from useTallies, and need the finished tasks to have arrived.
 */
export function capacityOf(
  cycles: Cycle[],
  tallies: Dict<Tally>,
  today: string,
): { points: number; cycles: number } | undefined {
  const ended = cycles
    .filter((c) => c.ends_on < today)
    .sort((a, b) => b.ends_on.localeCompare(a.ends_on))
    .slice(0, CAPACITY_CYCLES);
  if (ended.length === 0) return undefined;
  const done = ended.reduce((sum, c) => sum + (tallies[c.id]?.pointsDone ?? 0), 0);
  return { points: done / ended.length, cycles: ended.length };
}

export type Risk = "" | "past" | "soon" | "stale";

/** Why an epic is at risk, by the server's rules, or "". */
export function riskOf(epic: Epic, tally: Tally | undefined, now = Date.now()): Risk {
  if (!tally || epic.state === "done" || epic.state === "canceled" || tally.total - tally.done === 0) return "";
  if (epic.target_on) {
    const days = daysUntil(epic.target_on);
    if (days < 0) return "past";
    if (days <= 7 && tally.done * 2 < tally.total) return "soon";
  }
  if (epic.state === "active" && tally.lastMove && now - tally.lastMove > 14 * 24 * 3600_000) return "stale";
  return "";
}

export function riskLabel(risk: Risk): string {
  if (risk === "past") return t("ins.risk.past_target");
  if (risk === "soon") return t("ins.risk.due_soon");
  if (risk === "stale") return t("ins.risk.stalled");
  return "";
}

export const epicTones = {
  planned: "neutral",
  active: "accent",
  paused: "wait",
  done: "ok",
  canceled: "neutral",
} as const;
export const EPIC_STATES = ["planned", "active", "paused", "done", "canceled"] as const;
export const epicStateName = (state: string) => t(`epics.state.${state}` as "epics.state.planned");

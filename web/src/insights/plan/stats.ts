// Progress of epics, milestones and cycles, counted from the store so it
// moves the moment a task does. The rules match the server's dashboard:
// canceled tasks are left out, and "at risk" means the same three things.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import { daysUntil } from "@/lib/time";
import type { Epic, Status, Task } from "@/lib/types";

export interface Tally {
  total: number;
  done: number;
  /** Under way: started or waiting. */
  started: number;
  points: number;
  pointsDone: number;
  /** When any of its tasks last changed. */
  lastMove: number;
}

export const emptyTally = (): Tally => ({ total: 0, done: 0, started: 0, points: 0, pointsDone: 0, lastMove: 0 });

export function addTo(tally: Tally, task: Task, statuses: Dict<Status>) {
  const category = statuses[task.status_id]?.category;
  if (category === "canceled") return;
  tally.total++;
  tally.points += task.estimate ?? 0;
  if (category === "done") {
    tally.done++;
    tally.pointsDone += task.estimate ?? 0;
  } else if (category === "started" || category === "waiting") tally.started++;
  if (task.updated_at > tally.lastMove) tally.lastMove = task.updated_at;
}

export function tallyOf(tasks: Task[], statuses: Dict<Status>): Tally {
  const out = emptyTally();
  for (const task of tasks) addTo(out, task, statuses);
  return out;
}

/** A tally for every epic, milestone or cycle that has tasks, by its id. */
export function useTallies(field: "epic_id" | "milestone_id" | "cycle_id"): Dict<Tally> {
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  return useMemo(() => {
    const out: Dict<Tally> = {};
    for (const task of Object.values(tasks)) {
      const id = task[field];
      if (id && !task.deleted_at) addTo((out[id] ??= emptyTally()), task, statuses);
    }
    return out;
  }, [tasks, statuses, field]);
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

export const epicTones = { planned: "neutral", active: "accent", paused: "wait", done: "ok", canceled: "neutral" } as const;
export const EPIC_STATES = ["planned", "active", "paused", "done", "canceled"] as const;
export const epicStateName = (state: string) => t(`epics.state.${state}` as "epics.state.planned");

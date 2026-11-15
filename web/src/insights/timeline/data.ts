// What the timeline draws, read from the store: a project's epics with
// their tasks, progress and milestones, and the dated tasks with no epic.

import type { Changes } from "@/lib/changes.gen";
import { useMemo } from "react";
import { type ChangeSpec, send } from "@/lib/mutate";
import { useEpics, useLiveTasks, useLookup, useRows } from "@/lib/selectors";
import { type Category, type Epic, isCanceledCategory, isDoneCategory, type Milestone, type Task } from "@/lib/types";
import { dayFromNumber, dayNumber } from "@/lib/days";
import { localDay } from "@/lib/time";
import type { Extent } from "@/insights/timeline/scale";

export interface TaskLine {
  task: Task;
  category: Category;
  /** The day work began (or the task was made), as a day number. */
  start: number;
  /** The due day, when it has one. */
  due?: number;
}

export interface EpicLine {
  epic: Epic;
  start?: number;
  target?: number;
  tasks: TaskLine[];
  /** Tasks done and tasks in all, canceled ones left out. */
  done: number;
  total: number;
  milestones: { milestone: Milestone; day: number }[];
}

export interface TimelineData {
  epics: EpicLine[];
  /** Tasks with a due date and no epic. */
  loose: TaskLine[];
  /** The earliest and latest day anything is drawn at; null when nothing has a date. */
  extent: Extent | null;
  /** How many canceled epics there are, shown or not. */
  canceled: number;
}

/** Dated tasks first, soonest due on top; then the rest in their manual order. */
const byDue = (a: TaskLine, b: TaskLine) =>
  (a.due ?? Infinity) - (b.due ?? Infinity) || (a.task.rank < b.task.rank ? -1 : a.task.rank > b.task.rank ? 1 : 0);

export function useTimeline(projectId: string, showCanceled: boolean): TimelineData {
  const epics = useEpics(projectId);
  const tasks = useLiveTasks();
  const statuses = useLookup("statuses");
  const milestones = useRows("milestones");

  return useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    const see = (day: number | undefined) => {
      if (day === undefined) return;
      min = Math.min(min, day);
      max = Math.max(max, day);
    };

    const byEpic: Record<string, TaskLine[]> = {};
    const loose: TaskLine[] = [];
    for (const task of tasks) {
      if (task.project_id !== projectId) continue;
      const category = statuses[task.status_id]?.category ?? "backlog";
      if (isCanceledCategory(category) && !showCanceled) continue;
      const due = task.due_on ? dayNumber(task.due_on) : undefined;
      const began = dayNumber(localDay(task.started_at ?? task.created_at));
      const line: TaskLine = { task, category, start: due === undefined ? began : Math.min(began, due), due };
      if (task.epic_id) (byEpic[task.epic_id] ??= []).push(line);
      else if (due !== undefined) loose.push(line);
    }

    const lines: EpicLine[] = [];
    let canceled = 0;
    for (const epic of epics) {
      if (epic.state === "canceled") {
        canceled++;
        if (!showCanceled) continue;
      }
      const own = (byEpic[epic.id] ?? []).sort(byDue);
      const counted = own.filter((l) => !isCanceledCategory(l.category));
      const marks = milestones
        .filter((m) => m.epic_id === epic.id && m.target_on)
        .map((milestone) => ({ milestone, day: dayNumber(milestone.target_on as string) }))
        .sort((a, b) => a.day - b.day);
      const line: EpicLine = {
        epic,
        // An epic with a target but no start is drawn from the day it was made.
        start: epic.start_on
          ? dayNumber(epic.start_on)
          : epic.target_on && epic.created_at
            ? Math.min(dayNumber(localDay(epic.created_at)), dayNumber(epic.target_on))
            : undefined,
        target: epic.target_on ? dayNumber(epic.target_on) : undefined,
        tasks: own,
        done: counted.filter((l) => isDoneCategory(l.category)).length,
        total: counted.length,
        milestones: marks,
      };
      see(line.start);
      see(line.target);
      for (const m of marks) see(m.day);
      for (const l of own) {
        if (l.due === undefined) continue;
        see(l.start);
        see(l.due);
      }
      lines.push(line);
    }
    // Canceled epics go last: they are history, not plan.
    lines.sort((a, b) => Number(a.epic.state === "canceled") - Number(b.epic.state === "canceled"));
    for (const l of loose) {
      see(l.start);
      see(l.due);
    }
    return { epics: lines, loose: loose.sort(byDue), extent: min <= max ? { min, max } : null, canceled };
  }, [epics, tasks, statuses, milestones, projectId, showCanceled]);
}

/** Changes an epic's dates: only the ones that differ are sent. */
export function setEpicDates(epic: Epic, next: { start?: number; end?: number }) {
  const fields: Changes["epic.update"] = {};
  if (next.start !== undefined && dayFromNumber(next.start) !== epic.start_on)
    fields.start_on = dayFromNumber(next.start);
  if (next.end !== undefined && dayFromNumber(next.end) !== epic.target_on) fields.target_on = dayFromNumber(next.end);
  if (Object.keys(fields).length === 0) return;
  const change: ChangeSpec = { type: "epic.update", args: { id: epic.id, ...fields } };
  send(change, (tx) => tx.patch("epics", epic.id, fields));
}

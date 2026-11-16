// Every way these pages change an epic, a milestone or a cycle. Each shows
// the change at once and sends it as a named change (data/mutate.ts), and
// is remembered with its opposite, so Cmd+Z takes it back (data/undo.ts).

import type { Changes } from "@/types/changes.gen";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, send } from "@/data/mutate";
import { type Batch, sendUndoable, undo } from "@/data/undo";
import { rankBetween } from "@/lib/rank";
import { getRows } from "@/data/selectors";
import { toast } from "@/lib/toast";
import type { Cycle, Epic, Milestone, Task } from "@/types/core";

type Fields = Record<string, unknown>;

export interface EpicFields {
  name: string;
  description: string;
  state: Epic["state"];
  leadId: string;
  startOn: string;
  targetOn: string;
}

/** Creates an epic and resolves with its id; rejects (after a toast) if the server refuses. */
export async function createEpic(projectId: string, f: EpicFields): Promise<string> {
  const id = newId();
  const args: Changes["epic.create"] = { id, project: projectId, name: f.name.trim(), state: f.state };
  if (f.description.trim()) args.description = f.description;
  if (f.leadId) args.lead = f.leadId;
  if (f.startOn) args.start_on = f.startOn;
  if (f.targetOn) args.target_on = f.targetOn;
  const lastRank = getRows("epics").reduce((max, e) => (e.project_id === projectId && e.rank > max ? e.rank : max), "");
  await mutate(
    { type: "epic.create", args },
    (tx) =>
      tx.insert("epics", {
        id,
        project_id: projectId,
        name: args.name,
        description: args.description,
        state: f.state,
        lead_id: f.leadId || undefined,
        start_on: f.startOn || undefined,
        target_on: f.targetOn || undefined,
        rank: `${lastRank}z`,
        created_at: Date.now(),
      }),
    // The dialog shows the refusal.
    { quiet: true },
  );
  return id;
}

/** Row fields an epic.update argument lands in. */
const epicField: Record<string, string> = { lead: "lead_id" };

/** Changes some fields of an epic. Pass null to clear a date or the lead. */
export function updateEpic(
  epic: Epic,
  args: Partial<Record<"name" | "description" | "state" | "lead" | "start_on" | "target_on", string | null>>,
) {
  const local: Fields = {};
  for (const [arg, value] of Object.entries(args)) local[epicField[arg] ?? arg] = value === "" ? null : value;
  if (Object.keys(local).length === 0) return;
  const { back, before } = putBack(epic, args, epicField);
  sendUndoable(
    t("undo.plan.change", { what: epic.name }),
    {
      changes: [{ type: "epic.update", args: { id: epic.id, ...args } }],
      show: (tx) => tx.patch("epics", epic.id, local),
    },
    {
      changes: [{ type: "epic.update", args: { id: epic.id, ...back } }],
      show: (tx) => tx.patch("epics", epic.id, before),
    },
  );
}

/**
 * What puts a row's fields back after an update with `args`: the arguments
 * (null clears a field) and the row's fields as they stand now. `fieldOf`
 * names the row field of an argument that is not called the same.
 */
function putBack(row: object, args: Fields, fieldOf: Record<string, string> = {}) {
  const back: Record<string, string | null> = {};
  const before: Fields = {};
  for (const arg of Object.keys(args)) {
    const field = fieldOf[arg] ?? arg;
    const held = ((row as Fields)[field] as string | undefined) ?? null;
    back[arg] = held;
    before[field] = held;
  }
  return { back, before };
}

/** Deletes an epic; its tasks stay, without an epic. */
export function deleteEpic(epic: Epic) {
  send({ type: "epic.delete", args: { id: epic.id } }, (tx) => {
    for (const task of getRows("tasks")) {
      if (task.epic_id === epic.id) tx.patch("tasks", task.id, { epic_id: null, milestone_id: null });
    }
    tx.remove("epics", epic.id);
  });
}

export function setWatchingEpic(epic: Epic, userId: string, watching: boolean) {
  const set = (on: boolean): Batch => ({
    changes: [{ type: "watch.set", args: { type: "epic", subject: epic.id, watching: on } }],
    show: (tx) => {
      if (on)
        tx.insert("watchers", { user_id: userId, subject_type: "epic", subject_id: epic.id, created_at: Date.now() });
      else tx.remove("watchers", `${userId}:${epic.id}`);
    },
  });
  sendUndoable(t(watching ? "undo.watch" : "undo.unwatch", { what: epic.name }), set(watching), set(!watching));
}

export function createMilestone(epic: Epic, name: string, targetOn: string, after: Milestone | undefined) {
  const id = newId();
  const rank = rankBetween(after?.rank, undefined);
  const args: Changes["milestone.create"] = { id, epic: epic.id, name: name.trim(), rank };
  if (targetOn) args.target_on = targetOn;
  send({ type: "milestone.create", args }, (tx) =>
    tx.insert("milestones", { id, epic_id: epic.id, name: args.name, target_on: targetOn || undefined, rank }),
  );
}

export function updateMilestone(
  milestone: Milestone,
  args: Partial<Record<"name" | "target_on" | "rank", string | null>>,
) {
  const local: Fields = {};
  for (const [arg, value] of Object.entries(args)) local[arg] = value === "" ? null : value;
  const { back, before } = putBack(milestone, args);
  sendUndoable(
    t("undo.plan.change", { what: milestone.name }),
    {
      changes: [{ type: "milestone.update", args: { id: milestone.id, ...args } }],
      show: (tx) => tx.patch("milestones", milestone.id, local),
    },
    {
      changes: [{ type: "milestone.update", args: { id: milestone.id, ...back } }],
      show: (tx) => tx.patch("milestones", milestone.id, before),
    },
  );
}

/** Moves a milestone one place up or down among its epic's milestones (already in order). */
export function moveMilestone(ordered: Milestone[], milestone: Milestone, step: -1 | 1) {
  const i = ordered.findIndex((m) => m.id === milestone.id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  const rank =
    step < 0
      ? rankBetween(ordered[j - 1]?.rank, ordered[j]?.rank)
      : rankBetween(ordered[j]?.rank, ordered[j + 1]?.rank);
  updateMilestone(milestone, { rank });
}

/** Deletes a milestone; its tasks stay in the epic. */
export function deleteMilestone(milestone: Milestone) {
  send({ type: "milestone.delete", args: { id: milestone.id } }, (tx) => {
    for (const task of getRows("tasks")) {
      if (task.milestone_id === milestone.id) tx.patch("tasks", task.id, { milestone_id: null });
    }
    tx.remove("milestones", milestone.id);
  });
}

export function updateCycle(cycle: Cycle, args: Partial<Record<"name" | "starts_on" | "ends_on", string>>) {
  const { before } = putBack(cycle, args);
  // A cycle's name is cleared with "", and its dates are never empty.
  const back: typeof args = {};
  for (const arg of Object.keys(args) as (keyof typeof args)[]) back[arg] = cycle[arg] ?? "";
  sendUndoable(
    t("undo.plan.change", { what: cycle.name || t("undo.plan.cycle", { n: cycle.number }) }),
    {
      changes: [{ type: "cycle.update", args: { id: cycle.id, ...args } }],
      show: (tx) => tx.patch("cycles", cycle.id, { ...args, name: args.name === "" ? null : args.name }),
    },
    {
      changes: [{ type: "cycle.update", args: { id: cycle.id, ...back } }],
      show: (tx) => tx.patch("cycles", cycle.id, before),
    },
  );
}

/** Moves tasks to another cycle as one all-or-nothing batch, with a way back. */
export function moveToCycle(tasks: Task[], to: Cycle, toName: string) {
  if (tasks.length === 0) return;
  const move = (cycleOf: (task: Task) => string | null): Batch => ({
    changes: tasks.map((task): ChangeSpec => ({ type: "task.update", args: { id: task.id, cycle: cycleOf(task) } })),
    show: (tx) => {
      for (const task of tasks) tx.patch("tasks", task.id, { cycle_id: cycleOf(task) });
    },
  });
  const done = sendUndoable(
    t("undo.plan.toCycle", { n: tasks.length, name: toName }),
    move(() => to.id),
    move((task) => task.cycle_id ?? null),
  );
  toast.info(t("cycle.moved", { n: tasks.length, name: toName }), {
    label: t("common.undo"),
    run: () => void undo(done),
  });
}

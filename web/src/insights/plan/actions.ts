// Every way these pages change an epic, a milestone or a cycle. Each shows
// the change at once and sends it as a named change (lib/mutate.ts).

import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Cycle, Epic, Milestone, Task } from "@/lib/types";

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
  const args: Fields = { id, project: projectId, name: f.name.trim(), state: f.state };
  if (f.description.trim()) args.description = f.description;
  if (f.leadId) args.lead = f.leadId;
  if (f.startOn) args.start_on = f.startOn;
  if (f.targetOn) args.target_on = f.targetOn;
  const lastRank = Object.values(getState().collections.epics).reduce(
    (max, e) => (e.project_id === projectId && e.rank > max ? e.rank : max),
    "",
  );
  await mutate({ type: "epic.create", args }, (tx) =>
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
  send({ type: "epic.update", args: { id: epic.id, ...args } }, (tx) => tx.patch("epics", epic.id, local));
}

/** Deletes an epic; its tasks stay, without an epic. */
export function deleteEpic(epic: Epic) {
  send({ type: "epic.delete", args: { id: epic.id } }, (tx) => {
    for (const task of Object.values(getState().collections.tasks)) {
      if (task.epic_id === epic.id) tx.patch("tasks", task.id, { epic_id: null, milestone_id: null });
    }
    tx.remove("epics", epic.id);
  });
}

export function setWatchingEpic(epic: Epic, userId: string, watching: boolean) {
  send({ type: "watch.set", args: { type: "epic", subject: epic.id, watching } }, (tx) => {
    if (watching)
      tx.insert("watchers", { user_id: userId, subject_type: "epic", subject_id: epic.id, created_at: Date.now() });
    else tx.remove("watchers", `${userId}:${epic.id}`);
  });
}

export function createMilestone(epic: Epic, name: string, targetOn: string, after: Milestone | undefined) {
  const id = newId();
  const rank = rankBetween(after?.rank, undefined);
  const args: Fields = { id, epic: epic.id, name: name.trim(), rank };
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
  send({ type: "milestone.update", args: { id: milestone.id, ...args } }, (tx) =>
    tx.patch("milestones", milestone.id, local),
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
    for (const task of Object.values(getState().collections.tasks)) {
      if (task.milestone_id === milestone.id) tx.patch("tasks", task.id, { milestone_id: null });
    }
    tx.remove("milestones", milestone.id);
  });
}

export function updateCycle(cycle: Cycle, args: Partial<Record<"name" | "starts_on" | "ends_on", string>>) {
  send({ type: "cycle.update", args: { id: cycle.id, ...args } }, (tx) =>
    tx.patch("cycles", cycle.id, { ...args, name: args.name === "" ? null : args.name }),
  );
}

/** Moves tasks to another cycle as one all-or-nothing batch, with a way back. */
export function moveToCycle(tasks: Task[], to: Cycle, toName: string) {
  if (tasks.length === 0) return;
  const move = (cycleOf: (task: Task) => string | null) =>
    send(
      tasks.map((task): ChangeSpec => ({ type: "task.update", args: { id: task.id, cycle: cycleOf(task) } })),
      (tx) => {
        for (const task of tasks) tx.patch("tasks", task.id, { cycle_id: cycleOf(task) });
      },
    );
  move(() => to.id);
  toast.info(t("cycle.moved", { n: tasks.length, name: toName }), {
    label: t("common.undo"),
    run: () => move((task) => task.cycle_id ?? null),
  });
}

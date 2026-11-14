// Every way the app changes a task, in one place. Each function shows the
// change at once and sends it as a named change; several tasks go as one
// all-or-nothing batch. Always pass ids from the store.

import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, send } from "@/lib/mutate";
import { statusesOf } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import { isOpenCategory, type Status, type Task } from "@/lib/types";

type Fields = Record<string, unknown>;

/** Sends task.update for each task with the same arguments, patching the store with `local`. */
function updateAll(tasks: Task[], args: (task: Task) => Fields | null, local: (task: Task) => Fields) {
  const changes: ChangeSpec[] = [];
  const patches: [string, Fields][] = [];
  for (const task of tasks) {
    const a = args(task);
    if (!a) continue;
    changes.push({ type: "task.update", args: { id: task.id, ...a } });
    patches.push([task.id, local(task)]);
  }
  send(changes, (tx) => {
    for (const [id, fields] of patches) tx.patch("tasks", id, fields);
  });
}

/**
 * The status to use for a task when the one picked belongs to another
 * project: the same name there, else the first of the same category.
 */
export function statusFor(task: Task, status: Status): Status | undefined {
  if (status.project_id === task.project_id) return status;
  const own = statusesOf(getState().c.statuses, task.project_id);
  return own.find((s) => s.name === status.name) ?? own.find((s) => s.category === status.category);
}

export function setStatus(tasks: Task[], statusId: string) {
  const status = getState().c.statuses[statusId];
  if (!status) return;
  const target = (task: Task) => statusFor(task, status);
  updateAll(
    tasks,
    (task) => {
      const s = target(task);
      return s && s.id !== task.status_id ? { status: s.id } : null;
    },
    (task) => {
      const s = target(task) as Status;
      // A closed task waits on nobody; the server clears it too.
      return isOpenCategory(s.category) ? { status_id: s.id } : { status_id: s.id, waiting_on_id: null, waiting_on_note: null };
    },
  );
}

export function setAssignee(tasks: Task[], userId: string | null) {
  updateAll(
    tasks,
    (task) => ((task.assignee_id ?? null) === userId ? null : { assignee: userId }),
    () => ({ assignee_id: userId }),
  );
}

export function setWaitingOn(tasks: Task[], userId: string | null, note?: string) {
  updateAll(
    tasks,
    () => ({ waiting_on: userId, waiting_on_note: userId ? (note ?? "") : "" }),
    () => ({ waiting_on_id: userId, waiting_on_note: userId ? note || null : null }),
  );
}

export function setPriority(tasks: Task[], priority: number) {
  updateAll(
    tasks,
    (task) => (task.priority === priority ? null : { priority }),
    () => ({ priority }),
  );
}

/** Adds the label to every task, or removes it if they all have it already. */
export function toggleLabel(tasks: Task[], labelId: string) {
  const remove = tasks.every((task) => task.label_ids?.includes(labelId));
  updateAll(
    tasks,
    (task) => {
      const has = task.label_ids?.includes(labelId) ?? false;
      if (remove) return has ? { remove_labels: [labelId] } : null;
      return has ? null : { add_labels: [labelId] };
    },
    (task) => {
      const ids = (task.label_ids ?? []).filter((id) => id !== labelId);
      return { label_ids: remove ? (ids.length ? ids : null) : [...ids, labelId] };
    },
  );
}

/** Sets one simple field: the argument name the server takes and the row field it lands in. */
function setter(arg: string, field: string) {
  return (tasks: Task[], value: string | number | null) =>
    updateAll(
      tasks,
      (task) => (((task as unknown as Fields)[field] ?? null) === value ? null : { [arg]: value }),
      () => ({ [field]: value }),
    );
}

export const setEpic = setter("epic", "epic_id");
export const setMilestone = setter("milestone", "milestone_id");
export const setCycle = setter("cycle", "cycle_id");
export const setParent = setter("parent", "parent_id");
export const setDue = setter("due_on", "due_on");
export const setEstimate = setter("estimate", "estimate");
export const setTitle = setter("title", "title");
export const setDescription = setter("description", "description");

/** Moves a card on the board: a new place in the order, and maybe a new column. */
export function moveTask(task: Task, statusId: string, rank: string) {
  const args: Fields = { id: task.id, rank };
  if (statusId !== task.status_id) args.status = statusId;
  send({ type: "task.update", args }, (tx) => tx.patch("tasks", task.id, { status_id: statusId, rank }));
}

export function restoreTasks(tasks: Task[]) {
  send(
    tasks.map((task) => ({ type: "task.restore", args: { id: task.id } })),
    (tx) => {
      for (const task of tasks) tx.patch("tasks", task.id, { deleted_at: null });
    },
  );
}

/** Moves tasks to the trash, with a way back. */
export function trashTasks(tasks: Task[]) {
  if (tasks.length === 0) return;
  send(
    tasks.map((task) => ({ type: "task.delete", args: { id: task.id } })),
    (tx) => {
      for (const task of tasks) tx.patch("tasks", task.id, { deleted_at: Date.now() });
    },
  );
  toast.info(t("bulk.deleted", { n: tasks.length }), { label: t("common.undo"), run: () => restoreTasks(tasks) });
}

export interface NewTask {
  projectId: string;
  title: string;
  description?: string;
  statusId?: string;
  assigneeId?: string;
  priority?: number;
  labelIds?: string[];
  epicId?: string;
  parentId?: string;
  cycleId?: string;
  dueOn?: string;
  templateId?: string;
  /** Where it goes in manual order; the end of the list when left out. */
  rank?: string;
}

/**
 * Creates a task. It appears at once under the key it will most likely get;
 * the server's row replaces it a moment later. Resolves with the real key.
 */
export async function createTask(input: NewTask): Promise<string> {
  const { c, me } = getState();
  const project = c.projects[input.projectId];
  if (!project || !me) throw new Error("no project");
  const id = newId();
  const statuses = statusesOf(c.statuses, project.id);
  const status = (input.statusId && c.statuses[input.statusId]) || statuses.find((s) => s.is_default) || statuses[0];
  let number = 1;
  let lastRank = "";
  for (const task of Object.values(c.tasks)) {
    if (task.project_id !== project.id) continue;
    number = Math.max(number, task.number + 1);
    if (task.rank > lastRank) lastRank = task.rank;
  }
  const args: Fields = { id, project: project.id, title: input.title.trim() };
  if (input.description?.trim()) args.description = input.description;
  if (input.statusId) args.status = input.statusId;
  if (input.assigneeId) args.assignee = input.assigneeId;
  if (input.priority) args.priority = input.priority;
  if (input.labelIds?.length) args.labels = input.labelIds;
  if (input.epicId) args.epic = input.epicId;
  if (input.parentId) args.parent = input.parentId;
  if (input.cycleId) args.cycle = input.cycleId;
  if (input.dueOn) args.due_on = input.dueOn;
  if (input.templateId) args.template = input.templateId;
  if (input.rank) args.rank = input.rank;

  const now = Date.now();
  const results = await mutate({ type: "task.create", args }, (tx) => {
    if (!status) return;
    tx.insert("tasks", {
      id,
      project_id: project.id,
      number,
      key: `${project.key}-${number}`,
      title: args.title,
      description: input.description || undefined,
      status_id: status.id,
      priority: input.priority ?? 0,
      assignee_id: input.assigneeId,
      label_ids: input.labelIds?.length ? input.labelIds : undefined,
      epic_id: input.epicId,
      parent_id: input.parentId,
      cycle_id: input.cycleId,
      due_on: input.dueOn,
      rank: input.rank ?? `${lastRank}z`,
      created_by: me.user_id,
      created_at: now,
      updated_at: now,
      updated_seq: 0,
    });
  });
  return results[0]?.key ?? `${project.key}-${number}`;
}

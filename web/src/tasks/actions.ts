// Every way the app changes a task, in one place. Each function shows the
// change at once and sends it as a named change; several tasks go as one
// all-or-nothing batch. Always pass ids from the store.

import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { statusesOf } from "@/lib/selectors";
import { draftKey, getState } from "@/lib/store";
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
function statusFor(task: Task, status: Status): Status | undefined {
  if (status.project_id === task.project_id) return status;
  const own = statusesOf(getState().collections.statuses, task.project_id);
  return own.find((s) => s.name === status.name) ?? own.find((s) => s.category === status.category);
}

export function setStatus(tasks: Task[], statusId: string) {
  const status = getState().collections.statuses[statusId];
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
      return isOpenCategory(s.category)
        ? { status_id: s.id }
        : { status_id: s.id, waiting_on_id: null, waiting_outside: null, waiting_on_note: null };
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

export type TaskBudget = NonNullable<Task["budget"]>;

/** The picker id that stands for "an outside event" where a member's id would be. */
export const OUTSIDE = "outside";

/** True when the task's next move is nobody's here: it waits on something outside (a build, a reply, a date). */
export const waitsOutside = (task: Task) => task.waiting_outside === true;

export function setWaitingOn(tasks: Task[], userId: string | null, note?: string) {
  updateAll(
    tasks,
    () => ({ waiting_on: userId, waiting_on_note: userId ? (note ?? "") : "" }),
    () => ({ waiting_on_id: userId, waiting_outside: null, waiting_on_note: userId ? note || null : null }),
  );
}

/** The task waits on an outside event; the note says which. */
export function setWaitingOutside(tasks: Task[], note: string) {
  updateAll(
    tasks,
    () => ({ waiting_on: OUTSIDE, waiting_on_note: note }),
    () => ({ waiting_on_id: null, waiting_outside: true, waiting_on_note: note || null }),
  );
}

/** Gives one task a budget of its own (money, minutes of agent time, hand-offs between agents); null takes it away. */
export function setBudget(task: Task, budget: TaskBudget | null) {
  send({ type: "task.update", args: { id: task.id, budget } }, (tx) => tx.patch("tasks", task.id, { budget }));
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

/** What dropping a card in another column changes, besides its place in the order. */
export interface CardMove {
  statusId?: string;
  /** null takes the task from whoever has it. */
  assigneeId?: string | null;
  addLabel?: string;
  removeLabel?: string;
}

/**
 * Moves a card on the board: a new place in the order, and whatever its new
 * column stands for (a status, an assignee, a label in place of another).
 * All of it goes out as one task.update.
 */
export function moveCard(task: Task, rank: string | undefined, move: CardMove = {}) {
  const args: Fields = { id: task.id };
  const local: Fields = {};
  if (rank && rank !== task.rank) args.rank = local.rank = rank;
  if (move.statusId && move.statusId !== task.status_id) {
    args.status = move.statusId;
    local.status_id = move.statusId;
  }
  if (move.assigneeId !== undefined && (task.assignee_id ?? null) !== move.assigneeId) {
    args.assignee = move.assigneeId;
    local.assignee_id = move.assigneeId;
  }
  const had = task.label_ids ?? [];
  const add = move.addLabel && !had.includes(move.addLabel) ? move.addLabel : undefined;
  const remove = move.removeLabel && had.includes(move.removeLabel) ? move.removeLabel : undefined;
  if (add) args.add_labels = [add];
  if (remove) args.remove_labels = [remove];
  if (add || remove) {
    const next = [...had.filter((id) => id !== remove), ...(add ? [add] : [])];
    local.label_ids = next.length ? next : null;
  }
  if (Object.keys(args).length === 1) return;
  send({ type: "task.update", args }, (tx) => tx.patch("tasks", task.id, local));
}

/**
 * Moves tasks to another project, as one batch. Each gets a new key there
 * and the status of the same name (or kind); what belongs to the old
 * project (its labels, epic, cycle) is left behind. The server's answer
 * redraws them; nothing is guessed ahead of it.
 */
export function moveToProject(tasks: Task[], projectId: string) {
  const project = getState().collections.projects[projectId];
  const moving = tasks.filter((task) => task.project_id !== projectId);
  if (!project || moving.length === 0) return;
  mutate(moving.map((task) => ({ type: "task.move", args: { id: task.id, project: projectId } })))
    .then(() => toast.info(t("bulk.moved", { n: moving.length, project: project.name })))
    .catch(() => {});
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

/** Where new tasks of a project go: the next number, and the rank of the last task there. */
function endOf(projectId: string): { number: number; lastRank: string } {
  let number = 1;
  let lastRank = "";
  for (const task of Object.values(getState().collections.tasks)) {
    if (task.project_id !== projectId) continue;
    number = Math.max(number, task.number + 1);
    if (task.rank > lastRank) lastRank = task.rank;
  }
  return { number, lastRank };
}

/** The change that creates a task, and the row shown until the server's own arrives. */
function creation(input: NewTask, number: number, rank: string): { change: ChangeSpec; row: Fields } | null {
  const { collections: c, me } = getState();
  const project = c.projects[input.projectId];
  if (!project || !me) return null;
  const id = newId();
  const statuses = statusesOf(c.statuses, project.id);
  const status = (input.statusId && c.statuses[input.statusId]) || statuses.find((s) => s.is_default) || statuses[0];
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
  const row: Fields = {
    id,
    project_id: project.id,
    number,
    // Its real key comes with the server's answer; until then it reads "SVA-…".
    key: draftKey(project.key),
    title: args.title,
    description: input.description || undefined,
    status_id: status?.id,
    priority: input.priority ?? 0,
    assignee_id: input.assigneeId,
    label_ids: input.labelIds?.length ? input.labelIds : undefined,
    epic_id: input.epicId,
    parent_id: input.parentId,
    cycle_id: input.cycleId,
    due_on: input.dueOn,
    rank: input.rank ?? rank,
    created_by: me.user_id,
    created_at: now,
    updated_at: now,
    updated_seq: 0,
  };
  return { change: { type: "task.create", args }, row };
}

/**
 * Creates a task. It appears at once under the key it will most likely get;
 * the server's row replaces it a moment later. Resolves with the real key.
 */
export async function createTask(input: NewTask): Promise<string> {
  const { number, lastRank } = endOf(input.projectId);
  const made = creation(input, number, `${lastRank}z`);
  if (!made) throw new Error("no project");
  const results = await mutate(made.change, (tx) => {
    if (made.row.status_id) tx.insert("tasks", made.row);
  });
  return results[0]?.key ?? String(made.row.key);
}

/** The most changes the server takes in one request. */
const BATCH = 500;

/**
 * Creates several tasks that share everything but their titles. Each batch
 * of up to 500 is all-or-nothing; they are sent in order. Resolves with how
 * many were made; rejects with the server's reason if a batch is refused
 * (tasks of earlier batches stay).
 */
export async function createTasks(shared: Omit<NewTask, "title">, titles: string[]): Promise<number> {
  const end = endOf(shared.projectId);
  let rank = end.lastRank;
  const made = titles.map((title, i) => {
    rank = rankBetween(rank || undefined, undefined);
    return creation({ ...shared, title }, end.number + i, rank);
  });
  if (made.some((m) => !m)) throw new Error("no project");
  const all = made as { change: ChangeSpec; row: Fields }[];
  let done = 0;
  for (let from = 0; from < all.length; from += BATCH) {
    const batch = all.slice(from, from + BATCH);
    await mutate(
      batch.map((m) => m.change),
      (tx) => {
        for (const m of batch) if (m.row.status_id) tx.insert("tasks", m.row);
      },
      { quiet: true },
    );
    done += batch.length;
  }
  return done;
}

// Every way the app changes a task, in one place. Each function shows the
// change at once and sends it as a named change; several tasks go as one
// all-or-nothing batch. Always pass ids from the store.
//
// Each is also remembered with its opposite (data/undo.ts), so Cmd+Z takes
// it back: a selection changed at once is one step.

import type { Changes } from "@/types/changes.gen";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate } from "@/data/mutate";
import { type Batch, forget, remember, sendUndoable, undo } from "@/data/undo";
import { rankBetween } from "@/lib/rank";
import { getRow, getRows } from "@/data/selectors";
import { draftKey, getState } from "@/data/store";
import { toast } from "@/lib/toast";
import { isOpenCategory, type Status, type Task, type TaskLink } from "@/types/core";
import { projectStatuses } from "@/tasks/data";
import { OUTSIDE } from "@/tasks/properties/property";

type Fields = Record<string, unknown>;

type Update = Omit<Changes["task.update"], "id">;

/** The row field each argument of task.update lands in, for those that are one plain field. */
const FIELD_OF: Partial<Record<keyof Update, keyof Task>> = {
  title: "title",
  description: "description",
  status: "status_id",
  priority: "priority",
  assignee: "assignee_id",
  parent: "parent_id",
  epic: "epic_id",
  milestone: "milestone_id",
  cycle: "cycle_id",
  estimate: "estimate",
  due_on: "due_on",
  rank: "rank",
  handoff_limit: "handoff_limit",
};

/** What a change is called when it is undone: "change {the status} of SVA-12". */
type Changed = "status" | "assignee" | "waitingOn" | "priority" | "labels" | keyof typeof SIMPLE;
const SIMPLE = {
  epic: "epic_id",
  milestone: "milestone_id",
  cycle: "cycle_id",
  parent: "parent_id",
  due_on: "due_on",
  estimate: "estimate",
  handoff_limit: "handoff_limit",
  title: "title",
  description: "description",
} as const satisfies Partial<Record<keyof Update, keyof Task>>;

/** The tasks an undo step names: the one's key, or how many. */
const named = (tasks: Task[]) => (tasks.length === 1 && tasks[0] ? tasks[0].key : t("undo.tasks", { n: tasks.length }));

/** How the task waits, as task.update takes it. */
const waitOf = (task: Task): Update => ({
  waiting_on: task.waiting_outside ? OUTSIDE : (task.waiting_on_id ?? null),
  waiting_on_note: task.waiting_on_note ?? "",
});

/** The task.update that puts back what `args` changes, on the task as it stands before them. */
function opposite(task: Task, args: Update): Update {
  const row = task as unknown as Fields;
  const back: Update = {};
  const plain = back as Fields;
  for (const arg of Object.keys(args) as (keyof Update)[]) {
    const field = FIELD_OF[arg];
    if (field) plain[arg] = row[field] ?? null;
    else if (arg === "add_labels") back.remove_labels = args.add_labels;
    else if (arg === "remove_labels") back.add_labels = args.remove_labels;
    else if (arg === "waiting_on" || arg === "waiting_on_note") Object.assign(back, waitOf(task));
  }
  // Closing a task ends its wait: opening it again brings the wait back.
  if (args.status && (task.waiting_on_id || task.waiting_outside)) Object.assign(back, waitOf(task));
  return back;
}

/** One task.update on one task, there and back: the change, what it shows, and the same for its opposite. */
function there(task: Task, args: Update, local: Fields) {
  const row = task as unknown as Fields;
  const before: Fields = {};
  for (const field of Object.keys(local)) before[field] = row[field] ?? null;
  return { id: task.id, args, local, back: opposite(task, args), before };
}

/** Sends the updates as one batch, remembered under `name` with the batch that takes them back. */
function sendUpdates(name: string, updates: ReturnType<typeof there>[]) {
  if (updates.length === 0) return;
  const batch = (args: "args" | "back", local: "local" | "before"): Batch => ({
    changes: updates.map((u) => ({ type: "task.update", args: { id: u.id, ...u[args] } })),
    show: (tx) => {
      for (const u of updates) tx.patch("tasks", u.id, u[local]);
    },
  });
  sendUndoable(name, batch("args", "local"), batch("back", "before"));
}

/** Sends task.update for each task with the same arguments, patching the store with `local`. */
function updateAll(what: Changed, tasks: Task[], args: (task: Task) => Update | null, local: (task: Task) => Fields) {
  const updates = [];
  const changed = [];
  for (const task of tasks) {
    const a = args(task);
    if (!a) continue;
    updates.push(there(task, a, local(task)));
    changed.push(task);
  }
  sendUpdates(t("undo.change", { what: t(`undo.what.${what}`), of: named(changed) }), updates);
}

/**
 * The status to use for a task when the one picked belongs to another
 * project: the same name there, else the first of the same category.
 */
function statusFor(task: Task, status: Status): Status | undefined {
  if (status.project_id === task.project_id) return status;
  const own = projectStatuses(task.project_id);
  return own.find((s) => s.name === status.name) ?? own.find((s) => s.category === status.category);
}

export function setStatus(tasks: Task[], statusId: string) {
  const status = getRow("statuses", statusId);
  if (!status) return;
  const target = (task: Task) => statusFor(task, status);
  updateAll(
    "status",
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
    "assignee",
    tasks,
    (task) => ((task.assignee_id ?? null) === userId ? null : { assignee: userId }),
    () => ({ assignee_id: userId }),
  );
}

/** True when the task's next move is nobody's here: it waits on something outside (a build, a reply, a date). */
export const waitsOutside = (task: Task) => task.waiting_outside === true;

export function setWaitingOn(tasks: Task[], userId: string | null, note?: string) {
  updateAll(
    "waitingOn",
    tasks,
    () => ({ waiting_on: userId, waiting_on_note: userId ? (note ?? "") : "" }),
    () => ({ waiting_on_id: userId, waiting_outside: null, waiting_on_note: userId ? note || null : null }),
  );
}

/** The task waits on an outside event; the note says which. */
export function setWaitingOutside(tasks: Task[], note: string) {
  updateAll(
    "waitingOn",
    tasks,
    () => ({ waiting_on: OUTSIDE, waiting_on_note: note }),
    () => ({ waiting_on_id: null, waiting_outside: true, waiting_on_note: note || null }),
  );
}

export function setPriority(tasks: Task[], priority: number) {
  updateAll(
    "priority",
    tasks,
    (task) => (task.priority === priority ? null : { priority }),
    () => ({ priority }),
  );
}

/** Adds the label to every task, or removes it if they all have it already. */
export function toggleLabel(tasks: Task[], labelId: string) {
  const remove = tasks.every((task) => task.label_ids?.includes(labelId));
  updateAll(
    "labels",
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

/**
 * Sets one simple field on every task, by the argument the server takes for
 * it. A task property that is one plain field makes its own with this
 * (tasks/properties).
 */
export function setter(arg: keyof typeof SIMPLE) {
  const field = SIMPLE[arg];
  return (tasks: Task[], value: string | number | null) =>
    updateAll(
      arg,
      tasks,
      (task) => ((task[field] ?? null) === value ? null : { [arg]: value }),
      () => ({ [field]: value }),
    );
}

export const setEpic = setter("epic");
export const setMilestone = setter("milestone");
export const setCycle = setter("cycle");
export const setParent = setter("parent");
export const setDue = setter("due_on");
export const setEstimate = setter("estimate");
/** How many times the tasks may pass from agent to agent in all; null is no limit. */
export const setHandoffLimit = setter("handoff_limit");
export const setTitle = setter("title");
export const setDescription = setter("description");

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
  const args: Update = {};
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
  if (Object.keys(args).length === 0) return;
  sendUpdates(t("undo.move", { what: task.key }), [there(task, args, local)]);
}

/**
 * Moves tasks to another project, as one batch. Each gets a new key there
 * and the status of the same name (or kind); what belongs to the old
 * project (its labels, epic, cycle) is left behind. The server's answer
 * redraws them; nothing is guessed ahead of it.
 *
 * Undone, each task is moved back, where the server gives it its old key
 * again, and is given back what the move left behind.
 */
export function moveToProject(tasks: Task[], projectId: string) {
  const project = getRow("projects", projectId);
  const moving = tasks.filter((task) => task.project_id !== projectId);
  if (!project || moving.length === 0) return;
  const there: ChangeSpec[] = moving.map((task) => ({ type: "task.move", args: { id: task.id, project: projectId } }));
  const back: ChangeSpec[] = moving.flatMap((task): ChangeSpec[] => [
    { type: "task.move", args: { id: task.id, project: task.project_id } },
    {
      type: "task.update",
      args: {
        id: task.id,
        status: task.status_id,
        epic: task.epic_id ?? null,
        milestone: task.milestone_id ?? null,
        cycle: task.cycle_id ?? null,
        labels: task.label_ids ?? [],
      },
    },
  ]);
  const done = remember(
    t("undo.moveProject", { what: named(moving), project: project.name }),
    () => mutate(back),
    () => mutate(there),
  );
  mutate(there)
    .then(() => toast.info(t("bulk.moved", { n: moving.length, project: project.name })))
    .catch(() => forget(done));
}

const sendBatch = (batch: Batch) => mutate(batch.changes, batch.show);

/** The most changes the server takes in one request. */
const BATCH = 500;

/** Puts tasks just made in the trash, naming the changes that made them as undone, or takes them out again. */
function trashMade(made: Creation[], put: boolean) {
  const requests = [];
  for (let from = 0; from < made.length; from += BATCH) {
    const batch = trashing(made.slice(from, from + BATCH), put);
    if (put) batch.changes = batch.changes.map((change, i) => ({ ...change, undoes: made[from + i]?.change.id }));
    requests.push(sendBatch(batch));
  }
  return Promise.all(requests);
}

/** The batch that puts tasks in the trash, or takes them out of it. */
function trashing(tasks: { id: string }[], put: boolean): Batch {
  return {
    changes: tasks.map((task) => ({ type: put ? "task.delete" : "task.restore", args: { id: task.id } })),
    show: (tx) => {
      for (const task of tasks) tx.patch("tasks", task.id, { deleted_at: put ? Date.now() : null });
    },
  };
}

export function restoreTasks(tasks: Task[]) {
  if (tasks.length === 0) return;
  sendUndoable(t("undo.restore", { what: named(tasks) }), trashing(tasks, false), trashing(tasks, true));
}

/** Moves tasks to the trash, with a way back. */
export function trashTasks(tasks: Task[]) {
  if (tasks.length === 0) return;
  const done = sendUndoable(t("undo.delete", { what: named(tasks) }), trashing(tasks, true), trashing(tasks, false));
  toast.info(t("bulk.deleted", { n: tasks.length }), { label: t("common.undo"), run: () => void undo(done) });
}

/**
 * Has me watch the tasks, or stop watching them, as one step: what happens
 * to a task I watch comes to my inbox. A task already as asked is left out.
 */
export function setWatching(tasks: Task[], watching: boolean) {
  const userId = getState().me?.user_id;
  if (!userId) return;
  const changing = tasks.filter((task) => !!getRow("watchers", `${userId}:${task.id}`) !== watching);
  if (changing.length === 0) return;
  const set = (on: boolean): Batch => ({
    changes: changing.map((task) => ({ type: "watch.set", args: { subject: task.id, watching: on } })),
    show: (tx) => {
      for (const task of changing) {
        if (on)
          tx.insert("watchers", { user_id: userId, subject_type: "task", subject_id: task.id, created_at: Date.now() });
        else tx.remove("watchers", `${userId}:${task.id}`);
      }
    },
  });
  sendUndoable(t(watching ? "undo.watch" : "undo.unwatch", { what: named(changing) }), set(watching), set(!watching));
}

/** What a link is besides its task: enough to make it again. */
type LinkFields = Pick<TaskLink, "kind" | "url" | "title" | "repo" | "ref" | "state" | "checks" | "data">;

/**
 * Puts a link on a task and remembers it with its taking off, or the other
 * way round for a link that is there (`id`). A link put back is a new one,
 * under a new id: the server keeps the one taken off in the trash under its.
 */
function linkStep(name: string, task: Pick<Task, "id">, link: LinkFields, id?: string) {
  let at = id ?? "";
  const put = () => {
    at = newId();
    const made = at;
    return mutate({ type: "link.set", args: { id: made, task: task.id, ...link } }, (tx) =>
      tx.insert("links", { id: made, task_id: task.id, ...link }),
    );
  };
  const takeOff = () => {
    const gone = at;
    return mutate({ type: "link.remove", args: { id: gone } }, (tx) =>
      tx.patch("links", gone, { deleted_at: Date.now() }),
    );
  };
  const [first, back] = id ? [takeOff, put] : [put, takeOff];
  const done = remember(name, back, first);
  first().catch(() => forget(done));
}

/** Links a page to a task: the task lists the page, and the page the task (a link of kind doc, whose ref is the page). */
export function linkPage(task: Task, docId: string) {
  linkStep(t("undo.link", { what: task.key }), task, { kind: "doc", ref: docId });
}

/** Puts a web address on a task, under a title of its own when it has one. */
export function linkUrl(task: Task, url: string, title?: string) {
  linkStep(t("undo.link", { what: task.key }), task, title ? { kind: "url", url, title } : { kind: "url", url });
}

/** Takes a link off its task: a web address, a branch, a page. */
export function removeLink(id: string) {
  const link = getRow("links", id);
  if (!link) return;
  const { kind, url, title, repo, ref, state, checks, data } = link;
  const fields: LinkFields = { kind };
  for (const [name, value] of Object.entries({ url, title, repo, ref, state, checks, data })) {
    if (value) (fields as Fields)[name] = value;
  }
  const key = getRow("tasks", link.task_id)?.key ?? "";
  linkStep(t("undo.unlink", { what: key }), { id: link.task_id }, fields, id);
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
  for (const task of getRows("tasks")) {
    if (task.project_id !== projectId) continue;
    number = Math.max(number, task.number + 1);
    if (task.rank > lastRank) lastRank = task.rank;
  }
  return { number, lastRank };
}

interface Creation {
  id: string;
  change: ChangeSpec;
  row: Fields;
}

/** Remembers tasks being made, so that undo puts them in the trash and redo takes them out. `made` may still be filling. */
function rememberMade(name: string, made: Creation[]) {
  return remember(
    name,
    () => trashMade(made, true),
    () => trashMade(made, false),
    { warning: t("undo.warn.created") },
  );
}

/** The change that creates a task, and the row shown until the server's own arrives. */
function creation(input: NewTask, number: number, rank: string): Creation | null {
  const { me } = getState();
  const project = getRow("projects", input.projectId);
  if (!project || !me) return null;
  const id = newId();
  const statuses = projectStatuses(project.id);
  const status = getRow("statuses", input.statusId) || statuses.find((s) => s.is_default) || statuses[0];
  const args: Changes["task.create"] = { id, project: project.id, title: input.title.trim() };
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
  return { id, change: { id: newId(), type: "task.create", args }, row };
}

/**
 * Creates a task. It appears at once under the key it will most likely get;
 * the server's row replaces it a moment later. Resolves with the real key.
 */
export async function createTask(input: NewTask): Promise<string> {
  const { number, lastRank } = endOf(input.projectId);
  const made = creation(input, number, `${lastRank}z`);
  if (!made) throw new Error("no project");
  const done = rememberMade(t("undo.create", { what: t("undo.titled", { title: input.title.trim() }) }), [made]);
  try {
    const results = await mutate(made.change, (tx) => {
      if (made.row.status_id) tx.insert("tasks", made.row);
    });
    return results[0]?.key ?? String(made.row.key);
  } catch (err) {
    forget(done);
    throw err;
  }
}

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
  const all = made as Creation[];
  // One step to undo, of the tasks that were made: a batch refused leaves the earlier ones.
  const saved: Creation[] = [];
  const done = rememberMade(t("undo.create", { what: t("undo.tasks", { n: all.length }) }), saved);
  try {
    for (let from = 0; from < all.length; from += BATCH) {
      const batch = all.slice(from, from + BATCH);
      await mutate(
        batch.map((m) => m.change),
        (tx) => {
          for (const m of batch) if (m.row.status_id) tx.insert("tasks", m.row);
        },
        { quiet: true },
      );
      saved.push(...batch);
    }
  } catch (err) {
    if (saved.length === 0) forget(done);
    throw err;
  }
  return saved.length;
}

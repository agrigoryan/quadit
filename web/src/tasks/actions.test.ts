// What each task action sends to be undone (tasks/actions.ts): the change
// that puts back what the person saw, and the same change again on redo.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo, nextUndo, redo, undo, useUndo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, Task, User, Workspace } from "@/types/core";
import {
  createTask,
  createTasks,
  linkUrl,
  moveCard,
  moveToProject,
  removeLink,
  setAssignee,
  setDue,
  setStatus,
  toggleLabel,
  trashTasks,
} from "@/tasks/actions";

type Sent = { id: string; type: string; args: Record<string, unknown>; undoes?: string };

/** Each request the server was sent, as its changes. */
let requests: Sent[][] = [];

const settle = () => vi.advanceTimersByTimeAsync(0);
const task = (id: string) => getState().collections.tasks[id] as Task;
/** The changes of the last request, without the ids the queue gave them. */
const last = () => (requests.at(-1) ?? []).map(({ type, args }) => ({ type, args }));
const links = () => Object.values(getState().collections.links).filter((l) => !l.deleted_at);

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    requests.push(changes);
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  clearStore();
  clearUndo();
  useToasts.setState({ items: [] });
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p", key: "SVA", name: "Samurai" },
      { id: "q", key: "WEB", name: "Website" },
    ],
    statuses: [
      { id: "todo", project_id: "p", name: "Todo", category: "unstarted", is_default: true },
      { id: "done", project_id: "p", name: "Done", category: "done" },
    ],
    tasks: [
      { id: "t1", project_id: "p", number: 1, key: "SVA-1", title: "One", status_id: "todo", priority: 0, rank: "b" },
      {
        id: "t2",
        project_id: "p",
        number: 2,
        key: "SVA-2",
        title: "Two",
        status_id: "todo",
        priority: 0,
        rank: "d",
        assignee_id: "u2",
        waiting_on_id: "u3",
        waiting_on_note: "review",
        label_ids: ["bug"],
      },
    ],
  });
});

afterEach(async () => {
  await clearOutbox();
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("undoing a change to tasks", () => {
  it("puts a field back to what each task had, as one step for the whole selection", async () => {
    setAssignee([task("t1"), task("t2")], "u9");
    await settle();
    expect(nextUndo()?.name).toBe("change the assignee of 2 tasks");
    undo();
    expect(task("t1").assignee_id ?? null).toBeNull();
    expect(task("t2").assignee_id).toBe("u2");
    await settle();
    expect(last()).toEqual([
      { type: "task.update", args: { id: "t1", assignee: null } },
      { type: "task.update", args: { id: "t2", assignee: "u2" } },
    ]);
    redo();
    await settle();
    expect(last().map((c) => c.args.assignee)).toEqual(["u9", "u9"]);
    expect(useUndo.getState().done).toHaveLength(1);
  });

  it("remembers nothing for a change that changes nothing", () => {
    setAssignee([task("t2")], "u2");
    setDue([task("t1")], null);
    expect(nextUndo()).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("brings back who a task waited on when its closing is undone", async () => {
    setStatus([task("t2")], "done");
    expect(task("t2").waiting_on_id ?? null).toBeNull();
    await settle();
    undo();
    expect(task("t2")).toMatchObject({ status_id: "todo", waiting_on_id: "u3", waiting_on_note: "review" });
    await settle();
    expect(last()).toEqual([
      { type: "task.update", args: { id: "t2", status: "todo", waiting_on: "u3", waiting_on_note: "review" } },
    ]);
  });

  it("takes off the label it put on, and puts back the one it took off", async () => {
    toggleLabel([task("t1"), task("t2")], "ui");
    await settle();
    undo();
    await settle();
    expect(last().map((c) => c.args)).toEqual([
      { id: "t1", remove_labels: ["ui"] },
      { id: "t2", remove_labels: ["ui"] },
    ]);
    expect(task("t2").label_ids).toEqual(["bug"]);

    toggleLabel([task("t2")], "bug");
    await settle();
    undo();
    await settle();
    expect(last()[0]?.args).toEqual({ id: "t2", add_labels: ["bug"] });
  });

  it("moves a card back to its place, column and labels", async () => {
    moveCard(task("t2"), "x", { statusId: "done", assigneeId: null, addLabel: "ui", removeLabel: "bug" });
    await settle();
    expect(nextUndo()?.name).toBe("move SVA-2");
    undo();
    await settle();
    expect(last()[0]?.args).toEqual({
      id: "t2",
      rank: "d",
      status: "todo",
      assignee: "u2",
      remove_labels: ["ui"],
      add_labels: ["bug"],
      waiting_on: "u3",
      waiting_on_note: "review",
    });
    expect(task("t2")).toMatchObject({ rank: "d", status_id: "todo", assignee_id: "u2", label_ids: ["bug"] });
  });
});

describe("undoing the trash and the making of tasks", () => {
  it("restores trashed tasks from Cmd+Z or the note's own button, whichever comes first", async () => {
    trashTasks([task("t1"), task("t2")]);
    await settle();
    expect(task("t1").deleted_at).toBeTruthy();
    useToasts.getState().items[0]?.action?.run();
    await settle();
    expect(last().map((c) => c.type)).toEqual(["task.restore", "task.restore"]);
    expect(task("t1").deleted_at ?? null).toBeNull();
    // The button undid it: Cmd+Z has nothing left of it.
    expect(nextUndo()).toBeUndefined();
    redo();
    await settle();
    expect(last().map((c) => c.type)).toEqual(["task.delete", "task.delete"]);
  });

  it("puts a task just made in the trash, and takes it out again on redo", async () => {
    await createTask({ projectId: "p", title: "New one" });
    const made = requests[0]?.[0]?.args.id;
    expect(nextUndo()?.name).toBe("create “New one”");
    undo();
    await settle();
    expect(last()).toEqual([{ type: "task.delete", args: { id: made } }]);
    // The delete says which change it takes back, so nobody is told of a task made by mistake.
    expect(requests.at(-1)?.[0]?.undoes).toBe(requests[0]?.[0]?.id);
    redo();
    await settle();
    expect(last()).toEqual([{ type: "task.restore", args: { id: made } }]);
  });

  it("undoes several tasks made together as one step", async () => {
    await createTasks({ projectId: "p" }, ["A", "B", "C"]);
    expect(nextUndo()?.name).toBe("create 3 tasks");
    undo();
    await settle();
    expect(last().map((c) => c.type)).toEqual(["task.delete", "task.delete", "task.delete"]);
    expect(useUndo.getState().done).toEqual([]);
  });
});

describe("undoing a move to another project", () => {
  it("moves each task back and gives it what the move left behind", async () => {
    moveToProject([task("t2")], "q");
    await settle();
    expect(nextUndo()?.name).toBe("move SVA-2 to Website");
    undo();
    await settle();
    // Back in its project first, where the server gives it its key again; its status and labels are of that project.
    expect(last()).toEqual([
      { type: "task.move", args: { id: "t2", project: "p" } },
      {
        type: "task.update",
        args: { id: "t2", status: "todo", epic: null, milestone: null, cycle: null, labels: ["bug"] },
      },
    ]);
    redo();
    await settle();
    expect(last()).toEqual([{ type: "task.move", args: { id: "t2", project: "q" } }]);
  });
});

describe("undoing links", () => {
  it("takes a new link off, and puts it on again as a link of its own", async () => {
    linkUrl(task("t1"), "https://example.com", "Spec");
    await settle();
    const first = links()[0]?.id;
    undo();
    await settle();
    expect(last()).toEqual([{ type: "link.remove", args: { id: first } }]);
    expect(links()).toEqual([]);
    redo();
    await settle();
    // The server keeps the link taken off under its id: the one put back has another.
    const again = last()[0]?.args;
    expect(again).toMatchObject({ task: "t1", kind: "url", url: "https://example.com", title: "Spec" });
    expect(again?.id).not.toBe(first);
    undo();
    await settle();
    expect(last()).toEqual([{ type: "link.remove", args: { id: again?.id } }]);
  });

  it("puts back a link that was taken off, with what it pointed at", async () => {
    linkUrl(task("t1"), "https://example.com");
    await settle();
    const id = links()[0]?.id ?? "";
    removeLink(id);
    await settle();
    expect(nextUndo()?.name).toBe("remove a link from SVA-1");
    undo();
    await settle();
    expect(last()[0]).toMatchObject({
      type: "link.set",
      args: { task: "t1", kind: "url", url: "https://example.com" },
    });
    expect(links()).toHaveLength(1);
  });
});

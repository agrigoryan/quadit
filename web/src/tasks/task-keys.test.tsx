// @vitest-environment jsdom
// The keys that act on the tasks the keyboard is on (tasks/task-keys.tsx):
// I gives them to me and takes them back, the copy keys copy, Cmd+Backspace
// moves them to the trash, and none of them acts for someone who may not.
// S, A, P and L are tried on the task list (tasks/task-list.test.tsx).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, Task, User, Workspace } from "@/types/core";
import { useTaskKeys } from "@/tasks/task-keys";

const task = (n: number, fields: Partial<Task> = {}): Task => ({
  id: `t${n}`,
  project_id: "p1",
  number: n,
  key: `SVA-${n}`,
  title: `Fix the login ${n}`,
  status_id: "s",
  priority: 0,
  rank: String(n),
  created_by: "u",
  created_at: 0,
  updated_at: 0,
  created_seq: 0,
  updated_seq: 0,
  activity_seq: 0,
  ...fields,
});

function seed(scope?: Member["scope"], tasks = [task(1), task(2, { project_id: "p2" })]) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "member", kind: "person", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Live", rank: "a" },
      { id: "p2", key: "OPS", name: "Ops", rank: "b" },
    ],
    tasks,
  });
}

/** The keys, acting on the tasks with these ids. */
function Keys({ ids, onTrashed }: { ids: string[]; onTrashed?: () => void }) {
  const picker = useTaskKeys({
    tasksFor: () => ids.flatMap((id) => getState().collections.tasks[id] ?? []),
    anchorFor: () => document.body,
    onTrashed,
  });
  return (
    <>
      <input aria-label="field" />
      {picker}
    </>
  );
}

const press = (key: string, code: string, more: KeyboardEventInit = {}, target: Element = document.body) =>
  act(() => void fireEvent.keyDown(target, { key, code, ...more }));
const assignee = (id: string) => getState().collections.tasks[id]?.assignee_id ?? null;
const toasts = () => useToasts.getState().items.map((item) => item.text);
const copied = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
    Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
  );
  copied.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: copied }, configurable: true });
  clearUndo();
  useToasts.setState({ items: [] });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("I", () => {
  it("gives the task to me, and pressed again takes it off me", () => {
    seed();
    render(<Keys ids={["t1"]} />);
    press("i", "KeyI");
    expect(assignee("t1")).toBe("u1");
    press("i", "KeyI");
    expect(assignee("t1")).toBeNull();
  });

  it("works under another keyboard layout, and not with Shift", () => {
    seed();
    render(<Keys ids={["t1"]} />);
    press("I", "KeyI", { shiftKey: true });
    expect(assignee("t1")).toBeNull();
    press("ш", "KeyI");
    expect(assignee("t1")).toBe("u1");
  });

  it("gives every task of a selection to me when some are someone else's", () => {
    seed(undefined, [task(1, { assignee_id: "u1" }), task(3, { assignee_id: "u9" })]);
    render(<Keys ids={["t1", "t3"]} />);
    press("i", "KeyI");
    expect([assignee("t1"), assignee("t3")]).toEqual(["u1", "u1"]);
  });

  it("does nothing while a field is typed in", () => {
    seed();
    render(<Keys ids={["t1"]} />);
    press("i", "KeyI", {}, screen.getByLabelText("field"));
    expect(assignee("t1")).toBeNull();
  });

  it("leaves a task of a project I may not be given work in, and says so", () => {
    seed({ projects: ["p1"] });
    render(<Keys ids={["t1", "t2"]} />);
    press("i", "KeyI");
    expect([assignee("t1"), assignee("t2")]).toEqual(["u1", null]);
    expect(toasts()).toEqual(["Not given to you: you may not be given work in Ops"]);
  });

  it("does nothing for a read-only member", () => {
    seed({ read_only: true });
    render(<Keys ids={["t1"]} />);
    press("i", "KeyI");
    expect(assignee("t1")).toBeNull();
  });
});

describe("the copy keys", () => {
  it("copy the keys with Cmd+., and a branch name with Cmd+Shift+.", async () => {
    seed();
    render(<Keys ids={["t1", "t2"]} />);
    press(".", "Period", { metaKey: true });
    await vi.waitFor(() => expect(copied).toHaveBeenLastCalledWith("SVA-1, SVA-2"));
    press(">", "Period", { metaKey: true, shiftKey: true });
    await vi.waitFor(() => expect(copied).toHaveBeenLastCalledWith("sva-1-fix-the-login-1"));
    await vi.waitFor(() => expect(toasts()).toEqual(["Copied", "Copied"]));
  });
});

describe("Cmd+Backspace", () => {
  it("moves the tasks to the trash, with a way back, and says it is done", () => {
    seed();
    const trashed = vi.fn();
    render(<Keys ids={["t1"]} onTrashed={trashed} />);
    press("Backspace", "Backspace", { metaKey: true });
    expect(getState().collections.tasks.t1?.deleted_at).toBeTruthy();
    expect(trashed).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().items[0]?.action?.label).toBe("Undo");
  });

  it("does nothing for a task I may not change", () => {
    seed({ read_only: true });
    const trashed = vi.fn();
    render(<Keys ids={["t1"]} onTrashed={trashed} />);
    press("Backspace", "Backspace", { metaKey: true });
    expect(getState().collections.tasks.t1?.deleted_at).toBeFalsy();
    expect(trashed).not.toHaveBeenCalled();
  });
});

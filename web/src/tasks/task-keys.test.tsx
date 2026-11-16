// @vitest-environment jsdom
// The keys that act on the tasks the keyboard is on (tasks/task-keys.tsx):
// I gives them to me and takes them back, Shift+S watches them, the copy
// keys copy, Cmd+Backspace moves them to the trash, the Shift keys of the
// task properties open a picker or a form, and none of them acts for
// someone who may not. S, A, P and L are tried on the task list
// (tasks/task-list.test.tsx).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { type BootstrapData, clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo } from "@/data/undo";
import { useToasts } from "@/lib/toast";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
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

function seed(
  scope?: Member["scope"],
  tasks = [task(1), task(2, { project_id: "p2" })],
  settings?: Project["settings"],
  more: Pick<BootstrapData, "epics" | "milestones"> = {},
) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "member", kind: "person", scope } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Live", rank: "a", settings },
      { id: "p2", key: "OPS", name: "Ops", rank: "b" },
    ],
    cycles: [{ id: "c1", project_id: "p1", number: 1, starts_on: "2026-11-01", ends_on: "2026-11-14" }],
    tasks,
    ...more,
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

beforeAll(() => {
  // jsdom has no layout: nothing is ever resized, nor scrolled, as the pickers' lists ask.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});

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

  it("copy the first task's context pack with Cmd+Option+P, the copy asked for inside the key press", async () => {
    seed();
    const asked = vi.spyOn(api, "getText").mockResolvedValue("# SVA-1 Fix the login 1\n");
    // The clipboard is written as the key is pressed, with the text still on its way (Safari allows a copy only then).
    const items: Record<string, Promise<Blob>>[] = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly parts: Record<string, Promise<Blob>>) {
          items.push(parts);
        }
      },
    );
    const write = vi.fn<(items: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copied, write }, configurable: true });
    render(<Keys ids={["t1", "t2"]} />);
    // Option with P types π on a Mac: the key is named by where it is.
    press("π", "KeyP", { metaKey: true, altKey: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith("/api/v1/w/acme/tasks/SVA-1/context?format=text");
    const blob = await items[0]?.["text/plain"];
    expect(await blob?.text()).toBe("# SVA-1 Fix the login 1\n");
    await vi.waitFor(() => expect(toasts()).toEqual(["Copied"]));
    vi.unstubAllGlobals();
  });

  it("copy the context pack once it is here where the browser cannot copy what is still on its way", async () => {
    seed();
    vi.spyOn(api, "getText").mockResolvedValue("the pack");
    render(<Keys ids={["t1"]} />);
    press("p", "KeyP", { ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(copied).toHaveBeenLastCalledWith("the pack"));
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

describe("Shift+S", () => {
  const watching = (id: string) => !!getState().collections.watchers[`u1:${id}`];

  it("has me watch the tasks, and pressed again stop, as one step each", () => {
    seed(undefined, [task(1), task(3)]);
    render(<Keys ids={["t1", "t3"]} />);
    press("S", "KeyS", { shiftKey: true });
    expect([watching("t1"), watching("t3")]).toEqual([true, true]);
    press("S", "KeyS", { shiftKey: true });
    expect([watching("t1"), watching("t3")]).toEqual([false, false]);
  });

  it("does nothing for a member who may only read", () => {
    seed({ read_only: true });
    render(<Keys ids={["t1"]} />);
    press("S", "KeyS", { shiftKey: true });
    expect(watching("t1")).toBe(false);
  });
});

describe("the Shift keys of the task properties", () => {
  it("open the property's picker beside the task: Shift+C its cycle where the project has cycles", () => {
    seed(undefined, [task(1)], { cycles: true });
    // The picker's foot links to where the values are kept.
    render(
      <MemoryRouter>
        <Keys ids={["t1"]} />
      </MemoryRouter>,
    );
    press("C", "KeyC", { shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Set cycle…" })).toBeInTheDocument();
  });

  it("open nothing where a task has no such property: no cycles, no epic, no estimates", () => {
    seed(undefined, [task(1)]);
    render(<Keys ids={["t1"]} />);
    for (const [key, code] of [
      ["C", "KeyC"],
      ["M", "KeyM"],
      ["E", "KeyE"],
    ] as const)
      press(key, code, { shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offer with Shift+M only the milestones every task can take: those of their one epic", () => {
    seed(undefined, [task(1, { epic_id: "e1" }), task(3, { epic_id: "e1" }), task(4, { epic_id: "e2" })], undefined, {
      epics: [
        { id: "e1", project_id: "p1", name: "Launch", rank: "a" },
        { id: "e2", project_id: "p1", name: "Billing", rank: "b" },
      ],
      milestones: [
        { id: "m1", epic_id: "e1", name: "Beta", rank: "a" },
        { id: "m2", epic_id: "e2", name: "Invoices", rank: "a" },
      ],
    });
    const { unmount } = render(
      <MemoryRouter>
        <Keys ids={["t1", "t3"]} />
      </MemoryRouter>,
    );
    press("M", "KeyM", { shiftKey: true });
    const options = () => screen.getAllByRole("option").map((o) => o.textContent);
    expect(options()).toEqual([expect.stringContaining("No milestone"), expect.stringContaining("Beta")]);
    unmount();

    // In two epics, no milestone suits both: the server would refuse it for one.
    render(
      <MemoryRouter>
        <Keys ids={["t1", "t4"]} />
      </MemoryRouter>,
    );
    press("M", "KeyM", { shiftKey: true });
    expect(options()).toEqual([expect.stringContaining("No milestone")]);
  });

  it("open the form of a typed value, Shift+D the due date's, which sets it on every task", async () => {
    seed(undefined, [task(1), task(3)]);
    render(<Keys ids={["t1", "t3"]} />);
    press("D", "KeyD", { shiftKey: true });
    const form = screen.getByRole("dialog", { name: "Due date" });
    fireEvent.change(screen.getByLabelText("Due date for 2 tasks"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    const due = (id: string) => getState().collections.tasks[id]?.due_on;
    expect([due("t1"), due("t3")]).toEqual(["2026-12-01", "2026-12-01"]);
  });

  it("open the estimate's form where the project counts estimates", () => {
    seed(undefined, [task(1)], { estimates: true });
    render(<Keys ids={["t1"]} />);
    press("E", "KeyE", { shiftKey: true });
    expect(screen.getByLabelText("Estimate, in points, for 1 task")).toHaveFocus();
  });

  it("open nothing for a task I may not change", () => {
    seed({ read_only: true }, [task(1)]);
    render(<Keys ids={["t1"]} />);
    press("P", "KeyP", { shiftKey: true });
    press("D", "KeyD", { shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

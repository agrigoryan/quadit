// @vitest-environment jsdom
// The task list (tasks/task-list.tsx): its keys, on a small list rendered
// with a stand-in for the panel (the panel is open while the address is a
// task's), and its sub-tasks nested under their parents.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emptyCollections } from "@/lib/collections";
import { loadBootstrap, useStore } from "@/lib/store";
import { PeekContext } from "@/lib/task-link";
import type { Member, Task, User, Workspace } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { TaskList } from "@/tasks/task-list";
import { DisplayControls } from "@/tasks/view-controls";
import { defaultViewState } from "@/tasks/view-state";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  useStore.setState({ slug: "test" });
  // jsdom has no layout: nothing is ever resized.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Nor any scrolling, which the pickers' lists ask for.
  Element.prototype.scrollIntoView = () => {};
});

const task = (n: number, parent?: number, status = "s"): Task => ({
  id: `t${n}`,
  project_id: "p",
  number: n,
  key: `SVA-${n}`,
  title: `Task ${n}`,
  status_id: status,
  parent_id: parent === undefined ? undefined : `t${parent}`,
  priority: 0,
  rank: String(n),
  created_by: "u",
  created_at: 0,
  updated_at: 0,
  updated_seq: 0,
});

const group = (id: string, tasks: (number | Task)[]): TaskGroup => ({
  id,
  title: id,
  kind: "status",
  value: id,
  category: "unstarted",
  tasks: tasks.map((n) => (typeof n === "number" ? task(n) : n)),
});

const GROUPS = [group("Todo", [1, 2]), group("Doing", [3, 4]), group("Done", [5])];

/** The list with a panel that is open while the address is a task's, as the shell has it. */
function Page({ groups, nested }: { groups: TaskGroup[]; nested: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const key = /\/task\/([^/]+)$/.exec(location.pathname)?.[1];
  const peek = useMemo(() => ({ key, close: () => void navigate(-1) }), [key, navigate]);
  return (
    <PeekContext.Provider value={peek}>
      <input aria-label="field" />
      <TaskList
        groups={groups}
        nested={nested}
        sort="manual"
        selected={selected}
        onSelectedChange={setSelected}
        onAdd={() => {}}
      />
      {key && <div data-task-panel />}
      <output aria-label="address">{location.pathname}</output>
      <output aria-label="shown as">
        {(location.state as { background?: unknown } | null)?.background ? "panel" : "page"}
      </output>
      <output aria-label="selected">{[...selected].join(",")}</output>
    </PeekContext.Provider>
  );
}

/** Each test is a new step of the history, so none finds the place another left (lib/place.ts). */
let step = 0;

function renderList(groups = GROUPS, nested = true) {
  step += 1;
  render(
    <MemoryRouter initialEntries={[{ pathname: "/test/p/SVA/tasks", key: `step${step}` }]}>
      <TooltipProvider>
        <Page groups={groups} nested={nested} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const press = (key: string, target: Element = document.body) => act(() => void fireEvent.keyDown(target, { key }));
/** The key of the row the keyboard is on. */
const current = () => document.querySelector("[data-focused]")?.getAttribute("data-task") ?? null;
const address = () => screen.getByLabelText("address").textContent;

describe("TaskList keys", () => {
  it("moves the current row with J, K and the arrows, across group headings, stopping at the ends", () => {
    renderList();
    expect(current()).toBeNull();
    press("j");
    expect(current()).toBe("t1");
    press("j");
    press("j");
    expect(current()).toBe("t3");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(current()).toBe("t5");
    press("k");
    expect(current()).toBe("t4");
    press("ArrowUp");
    for (let i = 0; i < 5; i++) press("k");
    expect(current()).toBe("t1");
  });

  it("marks the row the keys are on as the current one, for a screen reader too", () => {
    renderList();
    press("j");
    press("j");
    expect(screen.getByRole("link", { current: true }).getAttribute("aria-label")).toBe("Open SVA-2");
  });

  it("starts from the last row on K", () => {
    renderList();
    press("k");
    expect(current()).toBe("t5");
  });

  it("steps over a folded group", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: /Doing/, expanded: true }));
    press("j");
    press("j");
    press("j");
    expect(current()).toBe("t5");
    press("k");
    expect(current()).toBe("t2");
  });

  it("opens the panel on Space, steps it with J and K, and closes it on Space with the same row current", () => {
    renderList();
    press("j");
    press(" ");
    expect(address()).toBe("/test/task/SVA-1");
    expect(screen.getByLabelText("shown as").textContent).toBe("panel");
    press("j");
    expect(address()).toBe("/test/task/SVA-2");
    press("j");
    press("k");
    expect(address()).toBe("/test/task/SVA-2");
    // Page keys rest while the panel covers the page.
    press("x");
    expect(screen.getByLabelText("selected").textContent).toBe("");
    press(" ");
    expect(address()).toBe("/test/p/SVA/tasks");
    expect(current()).toBe("t2");
  });

  it("opens the task's page on Enter", () => {
    renderList();
    press("j");
    press("j");
    press("Enter");
    expect(address()).toBe("/test/task/SVA-2");
    expect(screen.getByLabelText("shown as").textContent).toBe("page");
  });

  it("selects with X and clears the selection with Escape", () => {
    renderList();
    press("j");
    press("x");
    press("j");
    press("x");
    expect(screen.getByLabelText("selected").textContent).toBe("t1,t2");
    press("Escape");
    expect(screen.getByLabelText("selected").textContent).toBe("");
  });

  it("does nothing for keys typed in a field, or Space on a button", () => {
    renderList();
    const field = screen.getByLabelText("field");
    press("j", field);
    expect(current()).toBeNull();
    press("j");
    press(" ", screen.getByRole("button", { name: /Todo/, expanded: true }));
    expect(address()).toBe("/test/p/SVA/tasks");
  });
});

describe("TaskList sub-tasks", () => {
  // SVA-10 is in Doing; its sub-task SVA-11 (done) is in Todo, so Todo shows SVA-10 above it for context.
  const parent = task(10);
  const child = task(11, 10, "d");
  const NESTED = [group("Todo", [1, child]), group("Doing", [parent])];

  beforeAll(() => {
    const statuses = {
      s: { id: "s", project_id: "p", name: "Todo", category: "unstarted", rank: "a" },
      d: { id: "d", project_id: "p", name: "Done", category: "done", rank: "b" },
    } as unknown as ReturnType<typeof emptyCollections>["statuses"]; // only the fields a row reads
    useStore.setState({
      collections: { ...emptyCollections(), statuses, tasks: { t1: task(1), t10: parent, t11: child } },
    });
  });

  it("shows the parent's progress as a pill wherever the parent is listed", () => {
    renderList(NESTED);
    expect(screen.getAllByText("1 of 1 sub-tasks done")).toHaveLength(2);
  });

  it("nests the sub-task under a context row that says what it is and cannot be selected", () => {
    renderList(NESTED);
    expect(screen.getByRole("link", { name: "Open SVA-10, shown as the parent of tasks in this group" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: "Select SVA-10" })).toHaveLength(1);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => [item.getAttribute("data-task"), item.getAttribute("aria-level")])).toEqual([
      ["t1", "1"],
      ["t10", "1"],
      ["t11", "2"],
      ["t10", "1"],
    ]);
  });

  it("walks onto the context row with J, skips it with X, and opens the parent on Enter", () => {
    renderList(NESTED);
    press("j");
    press("j");
    expect(current()).toBe("t10");
    press("x");
    expect(screen.getByLabelText("selected").textContent).toBe("");
    press("Enter");
    expect(address()).toBe("/test/task/SVA-10");
  });

  it("leaves the context row out of a Shift range", () => {
    renderList(NESTED);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select SVA-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select SVA-11" }), { shiftKey: true });
    expect(screen.getByLabelText("selected").textContent).toBe("t1,t11");
  });

  it("folds a parent's sub-tasks with its control, and with Left and Right on the focused row", () => {
    renderList(NESTED);
    fireEvent.click(screen.getByRole("button", { name: "Hide the sub-tasks of SVA-10", expanded: true }));
    expect(screen.queryByRole("link", { name: "Open SVA-11" })).toBeNull();
    press("j");
    press("j");
    press("ArrowRight");
    expect(screen.getByRole("link", { name: "Open SVA-11" })).toBeTruthy();
    press("ArrowRight");
    expect(current()).toBe("t11");
    press("ArrowLeft");
    expect(current()).toBe("t10");
    press("ArrowLeft");
    expect(screen.getByRole("button", { name: "Show the sub-tasks of SVA-10", expanded: false })).toBeTruthy();
  });

  it("names each row's assignee control after who it is", () => {
    renderList(NESTED);
    expect(screen.getAllByRole("button", { name: "Assignee: Unassigned" }).length).toBeGreaterThan(0);
  });

  it("lists every task as its own row when flat", () => {
    renderList(NESTED, false);
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("button", { name: /sub-tasks of/ })).toBeNull();
    expect(screen.getAllByText("1 of 1 sub-tasks done")).toHaveLength(1);
  });
});

describe("DisplayControls", () => {
  it("offers sub-tasks nested or flat, nested to start with", () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <DisplayControls state={defaultViewState} onChange={onChange} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sub-tasks\s*Nested/ }));
    fireEvent.click(screen.getByRole("option", { name: "Flat" }));
    expect(onChange).toHaveBeenCalledWith({ subtasks: "flat" });
  });
});

describe("TaskList for who may change the tasks, and who may not", () => {
  const seed = (scope?: Member["scope"]) =>
    loadBootstrap("test", {
      seq: 1,
      me: { user_id: "u", handle: "ann", name: "Ann", role: "member", kind: "person", scope } as Member,
      user: { id: "u" } as User,
      workspace: { id: "w", slug: "test" } as Workspace,
      statuses: [{ id: "s", project_id: "p", name: "Todo", category: "unstarted", rank: "a" }],
      tasks: [task(1)],
    });
  const statusPicker = () => screen.queryByPlaceholderText("Change status…");

  it("opens the status picker with S, and from the row's own button", () => {
    seed();
    renderList([group("Todo", [1])]);
    press("j");
    press("s");
    expect(statusPicker()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Status: Todo" })).toBeEnabled();
  });

  it("opens nothing for a read-only member: S does nothing and the row's buttons are off", () => {
    seed({ read_only: true });
    renderList([group("Todo", [1])]);
    press("j");
    press("s");
    expect(statusPicker()).toBeNull();
    expect(screen.getByRole("button", { name: "Status: Todo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Assignee" })).toBeDisabled();
  });
});

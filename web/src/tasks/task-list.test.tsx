// @vitest-environment jsdom
// The task list's keys (tasks/task-list.tsx), on a small list rendered with a
// stand-in for the panel: the panel is open while the address is a task's.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useMemo, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { useStore } from "@/lib/store";
import { PeekContext } from "@/lib/task-link";
import type { Task } from "@/lib/types";
import type { TaskGroup } from "@/tasks/filters";
import { TaskList } from "@/tasks/task-list";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  useStore.setState({ slug: "test" });
  // jsdom has no layout: nothing is ever resized.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const task = (n: number): Task => ({
  id: `t${n}`,
  project_id: "p",
  number: n,
  key: `SVA-${n}`,
  title: `Task ${n}`,
  status_id: "s",
  priority: 0,
  rank: String(n),
  created_by: "u",
  created_at: 0,
  updated_at: 0,
  updated_seq: 0,
});

const group = (id: string, numbers: number[]): TaskGroup => ({
  id,
  title: id,
  kind: "status",
  value: id,
  category: "unstarted",
  tasks: numbers.map(task),
});

const GROUPS = [group("Todo", [1, 2]), group("Doing", [3, 4]), group("Done", [5])];

/** The list with a panel that is open while the address is a task's, as the shell has it. */
function Page({ groups }: { groups: TaskGroup[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const key = /\/task\/([^/]+)$/.exec(location.pathname)?.[1];
  const peek = useMemo(() => ({ key, close: () => void navigate(-1) }), [key, navigate]);
  return (
    <PeekContext.Provider value={peek}>
      <input aria-label="field" />
      <TaskList groups={groups} selected={selected} onSelectedChange={setSelected} onAdd={() => {}} />
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

function renderList(groups = GROUPS) {
  step += 1;
  render(
    <MemoryRouter initialEntries={[{ pathname: "/test/p/SVA/tasks", key: `step${step}` }]}>
      <TooltipProvider>
        <Page groups={groups} />
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

// @vitest-environment jsdom
// A page's flat run of task rows, driven as the task list is
// (tasks/row-keys.ts): J and K move, Space and Enter open, X selects and
// Cmd+A selects them all, Escape lets go, S opens the status picker for the
// selection or the focused row.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WithQuery } from "@/test/query";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Task, User, Workspace } from "@/types/core";
import { useTaskRowKeys } from "@/tasks/row-keys";
import { TaskRow } from "@/tasks/task-row";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  // jsdom has no layout: nothing is ever resized, nor scrolled.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});

const task = (n: number) =>
  ({
    id: `t${n}`,
    project_id: "p1",
    number: n,
    key: `SVA-${n}`,
    title: `Task ${n}`,
    status_id: "s1",
    rank: String(n),
    priority: 0,
  }) as Task;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "member", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [task(1), task(2), task(3)],
  });
});

function Page() {
  const scroller = useRef<HTMLDivElement>(null);
  const tasks = Object.values(getState().collections.tasks);
  const rows = useTaskRowKeys(tasks, scroller);
  return (
    <main>
      <div ref={scroller}>
        {tasks.map((tk) => (
          <TaskRow key={tk.id} task={tk} {...rows.rowProps(tk)} />
        ))}
      </div>
      {rows.picker}
      <output aria-label="selected">{rows.selected.map((tk) => tk.key).join(",")}</output>
      <output aria-label="address">{useLocation().pathname}</output>
    </main>
  );
}

/** Each test is a new step of the history, so none finds the place another left (nav/place.ts). */
let step = 0;

function renderPage() {
  step += 1;
  render(
    <MemoryRouter initialEntries={[{ pathname: "/acme/p/SVA/epics/e1", key: `step${step}` }]}>
      <TooltipProvider>
        <Page />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const press = (key: string, more: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(document.body, { key, ...more }));
const current = () => document.querySelector("[data-focused]")?.getAttribute("data-task") ?? null;
const selected = () => screen.getByLabelText("selected").textContent;

describe("useTaskRowKeys", () => {
  it("moves along the rows with J, K and the arrows", () => {
    renderPage();
    press("j");
    expect(current()).toBe("t1");
    press("ArrowDown");
    press("j");
    expect(current()).toBe("t3");
    press("k");
    expect(current()).toBe("t2");
  });

  it("opens the focused task in the panel with Space", () => {
    renderPage();
    press("j");
    press(" ");
    expect(screen.getByLabelText("address")).toHaveTextContent("/acme/task/SVA-1");
  });

  it("selects with X, all with Cmd+A, and lets go with Escape", () => {
    renderPage();
    press("j");
    press("x");
    expect(selected()).toBe("SVA-1");
    expect(screen.getByRole("checkbox", { name: /SVA-1/ })).toBeChecked();
    press("a", { code: "KeyA", metaKey: true });
    expect(selected()).toBe("SVA-1,SVA-2,SVA-3");
    press("Escape");
    expect(selected()).toBe("");
  });

  it("opens the status picker with S for the selection, else the focused row", () => {
    renderPage();
    press("j");
    press("s", { code: "KeyS" });
    expect(
      within(screen.getByRole("dialog", { name: "Change status…" })).getByRole("option", { name: /Todo/ }),
    ).toBeTruthy();
  });
});

// @vitest-environment jsdom
// The filter bar (tasks/filter-bar.tsx): the filters it offers in a project
// and across projects, the values each can take, and the chip an active
// filter shows.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Project, User, Workspace } from "@/types/core";
import { FilterBar } from "@/tasks/filter-bar";
import { emptyFilters, type Filters, toQuery } from "@/tasks/filters";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game", settings: { cycles: true } },
      { id: "p2", key: "OPS", name: "Ops" },
      { id: "p3", key: "TDW", name: "Tides", settings: { estimates: true, estimate_scale: "fibonacci" } },
    ],
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "s2", project_id: "p1", name: "Doing", category: "started", rank: "b" },
    ],
    members: [
      { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "member" },
      { user_id: "u2", handle: "coder", name: "Coder", kind: "agent", role: "member" },
    ],
    labels: [{ id: "l1", project_id: "p1", name: "bug" }],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
    cycles: [{ id: "c1", project_id: "p1", number: 4, starts_on: "2026-11-02", ends_on: "2026-11-15" }],
  });
});

const project = (id: string) => getState().collections.projects[id] as Project;

/** The bar with these filters; what it asks to change to is handed to `onChange`. */
function renderBar(filters: Filters, p: Project | undefined, onChange = vi.fn()) {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <FilterBar filters={filters} onChange={onChange} project={p} />
      </TooltipProvider>
    </MemoryRouter>,
  );
  return onChange;
}

const options = () =>
  within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.querySelector("span.flex-1")?.textContent);
const addFilter = () => fireEvent.click(screen.getByRole("button", { name: "Filter" }));
/** Picks the row with these words, whatever else it shows (an avatar's letters, a hint). */
const choose = (label: string) => {
  const rows = within(screen.getByRole("listbox")).getAllByRole("option");
  const row = rows.find((o) => o.querySelector("span.flex-1")?.textContent === label);
  if (!row) throw new Error(`no row ${label}`);
  fireEvent.click(row);
};

describe("FilterBar", () => {
  it("offers every filter in a project with cycles", () => {
    renderBar(emptyFilters, project("p1"));
    addFilter();
    expect(options()).toEqual([
      "Assignee",
      "Status",
      "Status type",
      "Label",
      "Priority",
      "Epic",
      "Cycle",
      "Waiting on",
      "Has open question",
    ]);
  });

  it("leaves out the cycle in a project without", () => {
    renderBar(emptyFilters, project("p2"));
    addFilter();
    expect(options()).not.toContain("Cycle");
    expect(options()).toContain("Status");
  });

  it("offers neither status nor cycle across projects", () => {
    renderBar(emptyFilters, undefined);
    addFilter();
    expect(options()).toEqual([
      "Assignee",
      "Status type",
      "Label",
      "Priority",
      "Epic",
      "Waiting on",
      "Has open question",
    ]);
  });

  it.each([
    ["Assignee", ["Unassigned", "Ann", "Coder"], "Coder", { assignee: ["u2"] }],
    ["Status", ["Todo", "Doing"], "Doing", { status: ["s2"] }],
    ["Status type", ["Backlog", "To do", "In progress", "Waiting", "Done", "Canceled"], "Done", { category: ["done"] }],
    ["Label", ["bug", "Manage labels"], "bug", { label: ["l1"] }],
    ["Priority", ["No priority", "Urgent", "High", "Medium", "Low"], "Low", { priority: [4] }],
    ["Epic", ["No epic", "Launch"], "No epic", { epic: ["none"] }],
    ["Cycle", ["No cycle", "Cycle 4"], "Cycle 4", { cycle: ["c1"] }],
    ["Waiting on", ["Ann", "Coder", "An outside event", "Nobody"], "An outside event", { waiting_on: "outside" }],
  ])("%s: offers its values and filters by the one picked", (filter, values, value, query) => {
    const onChange = renderBar(emptyFilters, project("p1"));
    addFilter();
    choose(filter);
    expect(options()).toEqual(values);
    choose(value);
    const next = onChange.mock.lastCall?.[0] as Filters;
    expect(toQuery(next, undefined, "manual")).toEqual({ ...query, sort: "rank" });
  });

  it("filters by an open question at once", () => {
    const onChange = renderBar(emptyFilters, project("p1"));
    addFilter();
    choose("Has open question");
    const next = onChange.mock.lastCall?.[0] as Filters;
    expect(toQuery(next, undefined, "manual")).toEqual({ has_open_decision: true, sort: "rank" });
  });

  it("shows an active filter as a chip with its value, and drops it from its cross", () => {
    const onChange = vi.fn();
    const ui = (filters: Filters) => (
      <MemoryRouter>
        <TooltipProvider>
          <FilterBar filters={filters} onChange={onChange} project={project("p1")} />
        </TooltipProvider>
      </MemoryRouter>
    );
    const { rerender } = render(ui(emptyFilters));
    addFilter();
    choose("Label");
    choose("bug");
    rerender(ui(onChange.mock.lastCall?.[0] as Filters));
    expect(screen.getByRole("button", { name: "Remove filter: Label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Label\s*bug$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Label" }));
    expect(toQuery(onChange.mock.lastCall?.[0] as Filters, undefined, "manual")).toEqual({ sort: "rank" });
  });

  it("shows an estimate saved off the project's scale by its points, and offers it to take off", () => {
    const onChange = renderBar({ ...emptyFilters, estimate: ["4"] }, project("p3"));
    const chip = screen.getByRole("button", { name: /^Estimate\s*4 points$/ });
    fireEvent.click(chip);
    expect(options()).toEqual(["No estimate", "1 point", "2 points", "3 points", "4 points", "5 points", "8 points"]);
    choose("4 points");
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ estimate: [] });
  });
});

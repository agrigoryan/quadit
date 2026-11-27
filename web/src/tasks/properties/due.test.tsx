// @vitest-environment jsdom
// A task's due date on its panel (tasks/properties/due.tsx, drawn by
// detail/properties.tsx): the date picker offers the common days by name,
// the end of the current cycle where the project works in cycles (whose
// days the month tints), and the milestone's and the epic's targets. Today
// is Thursday 26 November 2026.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { Properties } from "@/detail/properties";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { useRow } from "@/data/selectors";
import { clearStore, loadBootstrap } from "@/data/store";
import { fullDay, weekdayAndDay } from "@/lib/time";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function seed(settings: Project["settings"], task: Partial<Task> = {}) {
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", settings }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" }],
    // Wide enough to be the current one in any time zone.
    cycles: [{ id: "c1", project_id: "p1", number: 4, starts_on: "2026-11-16", ends_on: "2026-12-06" }],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", state: "active", rank: "a", target_on: "2026-12-18" }],
    milestones: [{ id: "m1", epic_id: "e1", name: "Beta", rank: "a", target_on: "2026-12-11" }],
    tasks: [
      {
        id: "t1",
        project_id: "p1",
        number: 1,
        key: "SVA-1",
        title: "First",
        status_id: "s1",
        priority: 0,
        rank: "a",
        ...task,
      },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 26, 12), toFake: ["Date"] });
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
  clearStore();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearOutbox();
  vi.restoreAllMocks();
});

function Panel() {
  const task = useRow("tasks", "t1");
  return task ? <Properties task={task} /> : null;
}

function openPicker() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Panel />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
  fireEvent.click(screen.getByRole("button", { name: "Due date: No due date" }));
  return screen.getByRole("dialog", { name: "Set due date…" });
}

const suggested = (picker: HTMLElement) =>
  within(within(picker).getByRole("toolbar", { name: "Suggested days" }))
    .getAllByRole("button")
    .map((button) => button.textContent);

describe("the due date's days by name", () => {
  it("are today, tomorrow, the end of this week, next week and two weeks on, each with its day", () => {
    seed({});
    const picker = openPicker();
    expect(suggested(picker)).toEqual([
      `Today${weekdayAndDay("2026-11-26")}`,
      `Tomorrow${weekdayAndDay("2026-11-27")}`,
      `End of this week${weekdayAndDay("2026-11-27")}`,
      `Next week${weekdayAndDay("2026-11-30")}`,
      `In two weeks${weekdayAndDay("2026-12-10")}`,
    ]);
  });

  it("say the end of next week on a weekend, when this week's working days are over", () => {
    vi.setSystemTime(new Date(2026, 10, 28, 12));
    seed({});
    const picker = openPicker();
    expect(suggested(picker)[2]).toBe(`End of next week${weekdayAndDay("2026-12-04")}`);
  });

  it("add the end of the current cycle where the project works in cycles, whose days the month tints", () => {
    seed({ cycles: true });
    const picker = openPicker();
    expect(suggested(picker).at(-1)).toBe(`End of this cycle${weekdayAndDay("2026-12-06")}`);
    const cell = (day: string) =>
      within(picker)
        .getByRole("button", { name: new RegExp(`^(Today, )?${fullDay(day)}`) })
        .closest("td");
    expect(cell("2026-11-20")).toHaveClass("bg-accent-soft");
    expect(cell("2026-11-13")).not.toHaveClass("bg-accent-soft");
  });

  it("add the milestone's and the epic's targets, and set the one picked", async () => {
    seed({}, { epic_id: "e1", milestone_id: "m1" });
    const picker = openPicker();
    expect(suggested(picker).slice(-2)).toEqual([
      `Milestone’s target${weekdayAndDay("2026-12-11")}`,
      `Epic’s target${weekdayAndDay("2026-12-18")}`,
    ]);
    fireEvent.click(within(picker).getByRole("button", { name: /^Epic’s target/ }));
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", due_on: "2026-12-18" } }]));
  });
});

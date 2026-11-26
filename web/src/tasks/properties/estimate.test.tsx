// @vitest-environment jsdom
// A task's estimate on its panel (tasks/properties/estimate.tsx, drawn by
// detail/properties.tsx): picked from the project's scale with Shift+E or
// from its row, said as a size on a T-shirt project, typed where the project
// takes any number; no estimate and 0 kept apart where 0 is allowed.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import { Properties } from "@/detail/properties";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { useRow } from "@/data/selectors";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
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
  await clearOutbox();
  vi.restoreAllMocks();
});

/** The panel of the task as the store has it, as the task's page draws it. */
function Panel() {
  const task = useRow("tasks", "t1");
  return task ? <Properties task={task} /> : null;
}

function renderPanel() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Panel />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const section = () => screen.getByRole("region", { name: "Properties" });
const shiftE = () => act(() => void fireEvent.keyDown(document.body, { key: "E", code: "KeyE", shiftKey: true }));
const options = () => screen.getAllByRole("option").map((o) => o.textContent);
const FIB = { estimates: true, estimate_scale: "fibonacci" } as const;

describe("the estimate on a scale", () => {
  it("opens the scale's values with Shift+E, and sets the one picked", async () => {
    seed(FIB);
    renderPanel();
    shiftE();
    expect(screen.getByRole("dialog", { name: "Set estimate…" })).toBeInTheDocument();
    expect(options()).toEqual(["No estimate", "1 point", "2 points", "3 points", "5 points", "8 points"]);
    fireEvent.click(screen.getByRole("option", { name: "5 points" }));
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: 5 } }]));
    expect(within(section()).getByRole("button", { name: "Estimate: 5 points" })).toBeInTheDocument();
  });

  it("offers the extended values and 0 where the project has them, and keeps 0 apart from none", async () => {
    seed({ ...FIB, estimate_extended: true, estimate_zero: true }, { estimate: 3 });
    renderPanel();
    fireEvent.click(within(section()).getByRole("button", { name: "Estimate: 3 points" }));
    expect(options()).toEqual([
      "No estimate",
      "0 points",
      "1 point",
      "2 points",
      "3 points",
      "5 points",
      "8 points",
      "13 points",
      "21 points",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "0 points" }));
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: 0 } }]));
    expect(within(section()).getByRole("button", { name: "Estimate: 0 points" })).toBeInTheDocument();

    fireEvent.click(within(section()).getByRole("button", { name: "Estimate: 0 points" }));
    fireEvent.click(screen.getByRole("option", { name: "No estimate" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ type: "task.update", args: { id: "t1", estimate: null } });
    expect(within(section()).getByRole("button", { name: "Estimate: No estimate" })).toBeInTheDocument();
  });

  it("says T-shirt sizes, each with its points beside it", async () => {
    seed({ estimates: true, estimate_scale: "tshirt" }, { estimate: 3 });
    renderPanel();
    expect(within(section()).getByRole("button", { name: "Estimate: M" })).toBeInTheDocument();
    shiftE();
    expect(options()).toEqual(["No estimate", "XS1 point", "S2 points", "M3 points", "L5 points", "XL8 points"]);
    fireEvent.click(screen.getByRole("option", { name: /^L/ }));
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: 5 } }]));
  });

  it("shows a value stored off the scale as its points", () => {
    seed({ estimates: true, estimate_scale: "tshirt" }, { estimate: 4 });
    renderPanel();
    expect(within(section()).getByRole("button", { name: "Estimate: 4 points" })).toBeInTheDocument();
  });
});

describe("the estimate in any number", () => {
  it("is typed in its box, which Shift+E gives the caret to", async () => {
    seed({ estimates: true }, { estimate: 3 });
    renderPanel();
    shiftE();
    const box = within(section()).getByLabelText<HTMLInputElement>("Estimate");
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "13" } });
    fireEvent.blur(box);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: 13 } }]));
  });

  it("takes 0 as an estimate where the project allows it, and as none where it does not", async () => {
    seed({ estimates: true, estimate_zero: true }, { estimate: 3 });
    renderPanel();
    const box = within(section()).getByLabelText<HTMLInputElement>("Estimate");
    fireEvent.change(box, { target: { value: "0" } });
    fireEvent.blur(box);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: 0 } }]));
    expect(box.value).toBe("0");
  });

  it("clears it for an empty box, where 0 is an estimate too", async () => {
    seed({ estimates: true, estimate_zero: true }, { estimate: 3 });
    renderPanel();
    const box = within(section()).getByLabelText<HTMLInputElement>("Estimate");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: null } }]));
    expect(box.value).toBe("");
  });

  it("clears it for 0 where 0 is not an estimate", async () => {
    seed({ estimates: true }, { estimate: 3 });
    renderPanel();
    const box = within(section()).getByLabelText<HTMLInputElement>("Estimate");
    fireEvent.change(box, { target: { value: "0" } });
    fireEvent.blur(box);
    await waitFor(() => expect(sent).toEqual([{ type: "task.update", args: { id: "t1", estimate: null } }]));
    expect(box.value).toBe("");
  });
});

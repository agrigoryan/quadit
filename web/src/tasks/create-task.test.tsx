// @vitest-environment jsdom
// The "new task" dialog (tasks/create-task.tsx, tasks/multi-create.tsx): one
// task closes the dialog at once and is sent behind it; several are sent as
// one batch with the button off, and a refusal keeps the dialog open.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { type Location, MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Project, Template, User, Workspace } from "@/types/core";
import { useToasts } from "@/lib/toast";
import { ui, useUi } from "@/lib/ui-state";
import { CreateTaskDialog } from "@/tasks/create-task";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

/** A change as the server receives it: JSON, read field by field. */
type Sent = { id: string; type: string; args: Record<string, unknown> };

interface Call {
  changes: Sent[];
  answer: () => void;
  fail: (err: unknown) => void;
}

/** Stands in for the server: every batch of changes waits until the test answers it. */
let calls: Call[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // The Write/Preview switch is a radio group in a form, which measures itself; jsdom cannot.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  calls = [];
  vi.spyOn(api, "post").mockImplementation(
    (_path: string, body?: unknown) =>
      new Promise((resolve, reject) => {
        const changes = (body as { changes: Sent[] }).changes;
        calls.push({
          changes,
          answer: () => resolve({ results: changes.map((_, i) => ({ key: `SVA-${i + 1}` })) }),
          fail: reject,
        });
      }),
  );
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" }],
    members: [{ user_id: "u1", handle: "ann", name: "Ann" }],
  });
});

afterEach(async () => {
  await clearOutbox();
  for (const call of calls) call.fail(new Error("test over"));
  ui.closeNewTask();
  vi.restoreAllMocks();
});

/** As the shell does it: the dialog is there while there is a draft. */
function Host() {
  const draft = useUi((s) => s.newTask);
  return draft ? <CreateTaskDialog draft={draft} /> : null;
}

/** The address the test is at, written down whenever it changes. */
let here: Location | undefined;
function Here() {
  const location = useLocation();
  useEffect(() => {
    here = location;
  }, [location]);
  return null;
}

function open(many = false, at: { pathname: string; state?: unknown } = { pathname: "/acme/tasks" }) {
  ui.newTask({ projectId: "p1", ...(many ? { many: true } : {}) });
  render(
    <MemoryRouter initialEntries={[at]}>
      <TooltipProvider>
        <Host />
        <Here />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const isOpen = () => useUi.getState().newTask !== null;

describe("CreateTaskDialog, one task", () => {
  const create = () => screen.getByRole("button", { name: /^Create task/ });
  const title = () => screen.getByLabelText("Task title");

  it("asks for a title, puts the cursor there, and sends nothing", () => {
    open();
    act(() => screen.getByLabelText("Add a description… Markdown works.").focus());
    fireEvent.click(create());
    expect(screen.getByRole("alert")).toHaveTextContent("Give the task a title");
    expect(title()).toHaveFocus();
    expect(title()).toHaveAttribute("aria-invalid", "true");
    expect(isOpen()).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("drops the message once a title is typed, and asks again when the title is emptied and sent", () => {
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Create more" }));
    fireEvent.click(create());
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(title()).not.toBeInvalid();
    fireEvent.change(title(), { target: { value: "" } });
    fireEvent.click(create());
    expect(screen.getByRole("alert")).toHaveTextContent("Give the task a title");
  });

  it("closes at once and sends the task once, also for a double click", async () => {
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.click(create());
    expect(isOpen()).toBe(false);
    expect(screen.queryByRole("button", { name: /^Create task/ })).toBeNull();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes).toHaveLength(1);
    expect(calls[0]?.changes[0]).toMatchObject({ type: "task.create", args: { title: "Fix the menu" } });
  });

  it("opens the new task from its toast in the panel, over the page that was under the panel", async () => {
    open(false, { pathname: "/acme/task/SVA-9", state: { background: { pathname: "/acme/tasks" } } });
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]?.answer());
    await waitFor(() => expect(useToasts.getState().items.at(-1)?.action).toBeDefined());
    act(() => useToasts.getState().items.at(-1)?.action?.run());
    expect(here?.pathname).toBe("/acme/task/SVA-1");
    expect((here?.state as { background?: Location } | null)?.background?.pathname).toBe("/acme/tasks");
  });

  it("creates with Cmd/Ctrl-Enter from the title", async () => {
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.keyDown(title(), { key: "Enter", ctrlKey: true });
    expect(isOpen()).toBe(false);
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("with Create more, stays open, empties the title and puts the cursor back in it", async () => {
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Create more" }));
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.change(screen.getByLabelText("Add a description… Markdown works."), { target: { value: "soon" } });
    fireEvent.click(create());
    expect(isOpen()).toBe(true);
    expect(title()).toHaveValue("");
    expect(title()).toHaveFocus();
    expect(screen.getByLabelText("Add a description… Markdown works.")).toHaveValue("");
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe("CreateTaskDialog, the estimate", () => {
  const create = () => screen.getByRole("button", { name: /^Create task/ });
  const title = () => screen.getByLabelText("Task title");
  /** The project estimates as these settings say. */
  function estimating(settings: Project["settings"], templates: Template[] = []) {
    clearStore();
    loadBootstrap("acme", {
      seq: 1,
      me: { user_id: "u1", handle: "ann", name: "Ann" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
      projects: [{ id: "p1", key: "SVA", name: "Game", settings }],
      statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" }],
      members: [{ user_id: "u1", handle: "ann", name: "Ann" }],
      templates,
    });
  }
  /** A template that stores 4, off the Fibonacci scale. */
  const SPIKE = { id: "tp1", project_id: "p1", name: "Spike", preset: { estimate: 4 }, created_at: 0, updated_seq: 0 };
  const FIB = { estimates: true, estimate_scale: "fibonacci" } as const;
  const fromTemplate = () => {
    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    fireEvent.click(screen.getByRole("option", { name: "Spike" }));
  };
  const sent = () => calls[0]?.changes[0]?.args ?? {};

  it("has no pill where the project does not estimate", () => {
    open();
    expect(screen.queryByRole("button", { name: "Estimate" })).toBeNull();
  });

  it("is picked from the project's scale, and sent with the task", async () => {
    estimating({ estimates: true, estimate_scale: "tshirt" });
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    fireEvent.click(screen.getByRole("option", { name: /^M/ }));
    expect(screen.getByRole("button", { name: "M" })).toBeInTheDocument();
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes[0]).toMatchObject({ type: "task.create", args: { estimate: 3 } });
  });

  it("opens with Shift+E while the caret is in no box, and sends a zero estimate as 0", async () => {
    estimating({ estimates: true, estimate_scale: "fibonacci", estimate_zero: true });
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    // Typed in the title, Shift+E is a capital E.
    fireEvent.keyDown(title(), { key: "E", code: "KeyE", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Set estimate…" })).toBeNull();
    // On the row of pills, as after Tab, it opens the estimate's.
    const priority = screen.getByRole("button", { name: "Priority" });
    act(() => priority.focus());
    fireEvent.keyDown(priority, { key: "E", code: "KeyE", shiftKey: true });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Set estimate…" })).getByRole("option", { name: "0 points" }),
    );
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes[0]).toMatchObject({ type: "task.create", args: { estimate: 0 } });
  });

  it("is typed where the project takes any number, and Set keeps the dialog open", async () => {
    estimating({ estimates: true });
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    fireEvent.change(screen.getByLabelText("Estimate, in points"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(isOpen()).toBe(true);
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "8 points" })).toBeInTheDocument();
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sent()).toMatchObject({ estimate: 8 });
  });

  it("is typed for several tasks at once too, and Set keeps that dialog open", async () => {
    estimating({ estimates: true });
    open(true);
    fireEvent.change(screen.getByLabelText("Task titles, one per line"), { target: { value: "one\ntwo" } });
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    fireEvent.change(screen.getByLabelText("Estimate, in points"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(isOpen()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Create 2 tasks/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes.map((c) => c.args.estimate)).toEqual([8, 8]);
  });

  it("leaves a template's estimate to the server, shown on the pill, when it is not changed", async () => {
    estimating(FIB, [SPIKE]);
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fromTemplate();
    expect(screen.getByRole("button", { name: "4 points" })).toBeInTheDocument();
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sent()).toMatchObject({ template: "tp1" });
    expect(sent()).not.toHaveProperty("estimate");
  });

  it("shows a template's stored 0 as an estimate where the project allows zero", () => {
    estimating({ ...FIB, estimate_zero: true }, [{ ...SPIKE, preset: { estimate: 0 } }]);
    open();
    fromTemplate();
    expect(screen.getByRole("button", { name: "0 points" })).toBeInTheDocument();
  });

  it("sends No estimate as null, over the template's", async () => {
    estimating(FIB, [SPIKE]);
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fromTemplate();
    fireEvent.click(screen.getByRole("button", { name: "4 points" }));
    fireEvent.click(screen.getByRole("option", { name: "No estimate" }));
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sent()).toMatchObject({ template: "tp1", estimate: null });
  });

  it("sends a value picked over the template's as that value", async () => {
    estimating(FIB, [SPIKE]);
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fromTemplate();
    fireEvent.click(screen.getByRole("button", { name: "4 points" }));
    fireEvent.click(screen.getByRole("option", { name: "5 points" }));
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sent()).toMatchObject({ template: "tp1", estimate: 5 });
  });

  it("leaves the estimate out where none is picked", async () => {
    estimating({ estimates: true });
    open();
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes[0]?.args).not.toHaveProperty("estimate");
  });
});

describe("CreateTaskDialog, several tasks", () => {
  const create = () => screen.getByRole("button", { name: /^Create \d+ task/ });
  const titles = () => screen.getByLabelText("Task titles, one per line");

  it("turns the button off while the batch is out and sends it once for a double click, then closes", async () => {
    open(true);
    fireEvent.change(titles(), { target: { value: "- one\n- two" } });
    fireEvent.click(create());
    fireEvent.click(create());
    expect(create()).toBeDisabled();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes.map((c) => c.args.title)).toEqual(["one", "two"]);
    await act(async () => calls[0]?.answer());
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(calls).toHaveLength(1);
  });

  it("keeps the list and says why when the batch is refused, with the button back on", async () => {
    open(true);
    fireEvent.change(titles(), { target: { value: "one\ntwo" } });
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.fail(new ApiError(400, { message: "title is too long", field: "title" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("title is too long");
    expect(create()).toBeEnabled();
    expect(titles()).toHaveValue("one\ntwo");
    expect(isOpen()).toBe(true);

    // The message is about the list as it was: editing the list takes it away.
    fireEvent.change(titles(), { target: { value: "one" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(titles()).not.toBeInvalid();
  });

  it("asks for a title when there is none, with Cmd/Ctrl-Enter", () => {
    open(true);
    fireEvent.keyDown(titles(), { key: "Enter", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Write at least one title");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("replaces a refusal with what is missing when the next try has no title", async () => {
    open(true);
    fireEvent.change(titles(), { target: { value: "one" } });
    fireEvent.click(create());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.fail(new ApiError(400, { message: "title is too long" })));
    fireEvent.change(titles(), { target: { value: "" } });
    fireEvent.keyDown(titles(), { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Write at least one title");
  });
});

describe("CreateTaskDialog, the properties under the description", () => {
  beforeAll(() => {
    // The pickers' lists scroll and measure; jsdom does neither.
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    loadBootstrap("acme", {
      seq: 2,
      me: { user_id: "u1", handle: "ann", name: "Ann", role: "owner" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
      projects: [{ id: "p1", key: "SVA", name: "Game" }],
      statuses: [
        { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" },
        { id: "s2", project_id: "p1", name: "Doing", category: "started", rank: "b" },
      ],
      members: [
        { user_id: "u1", handle: "ann", name: "Ann", kind: "person" },
        { user_id: "u2", handle: "coder", name: "Coder", kind: "agent" },
      ],
      labels: [{ id: "l1", project_id: "p1", name: "bug" }],
      epics: [{ id: "e1", project_id: "p1", name: "Launch", rank: "a" }],
      templates: [{ id: "tp1", project_id: "p1", name: "Bug report" }],
      tasks: [
        {
          id: "t9",
          project_id: "p1",
          number: 9,
          key: "SVA-9",
          title: "Parent",
          status_id: "s1",
          priority: 0,
          rank: "a",
        },
      ],
    });
  });

  /** The row of property buttons, by what each shows. */
  const pills = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll("form > div:last-child > *")].map((el) => el.textContent);
  const choose = (button: RegExp, label: string) => {
    fireEvent.click(screen.getByRole("button", { name: button }));
    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    const row = rows.find((o) => o.querySelector("span.flex-1")?.textContent === label);
    if (!row) throw new Error(`no row ${label}`);
    fireEvent.click(row);
  };

  it("offers status, assignee, priority, labels, epic, parent, due date and template, in that order", () => {
    open();
    expect(pills(screen.getByRole("dialog"))).toEqual([
      "Todo",
      "Assignee",
      "Priority",
      "Labels",
      "Epic",
      "Parent",
      "Due date",
      "Template",
    ]);
  });

  it("offers the same for several tasks but the parent and the template", () => {
    open(true);
    expect(pills(screen.getByRole("dialog"))).toEqual(["Todo", "Assignee", "Priority", "Labels", "Epic", "Due date"]);
  });

  it("creates the task with what was picked", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Fix the menu" } });
    choose(/^Status/, "Doing");
    choose(/^Assignee$/, "Coder");
    choose(/^Priority$/, "High");
    choose(/^Labels/, "bug");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    choose(/^Epic$/, "Launch");
    choose(/^Parent$/, "Parent");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create task/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes[0]?.args).toMatchObject({
      project: "p1",
      title: "Fix the menu",
      status: "s2",
      assignee: "u2",
      priority: 2,
      labels: ["l1"],
      epic: "e1",
      parent: "t9",
      due_on: "2026-12-01",
    });
  });
});

describe("CreateTaskDialog, for a read-only member", () => {
  it("offers nothing to create and sends nothing", () => {
    const me = { user_id: "u1", handle: "ann", name: "Ann", scope: { read_only: true } } as Member;
    loadBootstrap("acme", {
      seq: 2,
      me,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
      projects: [{ id: "p1", key: "SVA", name: "Game" }],
      statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", is_default: true, rank: "a" }],
    });
    open();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Fix the menu" } });
    expect(screen.getByRole("button", { name: /^Create task/ })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Task title"));
    expect(isOpen()).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });
});

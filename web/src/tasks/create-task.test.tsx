// @vitest-environment jsdom
// The "new task" dialog (tasks/create-task.tsx, tasks/multi-create.tsx): one
// task closes the dialog at once and is sent behind it; several are sent as
// one batch with the button off, and a refusal keeps the dialog open.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { clearOutbox } from "@/lib/mutate";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
import { ui, useUi } from "@/lib/ui-state";
import { CreateTaskDialog } from "@/tasks/create-task";
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

function open(many = false) {
  ui.newTask({ projectId: "p1", ...(many ? { many: true } : {}) });
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Host />
      </TooltipProvider>
    </MemoryRouter>,
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

  it("keeps the message while the title is typed, and drops it when the task is created", () => {
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Create more" }));
    fireEvent.click(create());
    fireEvent.change(title(), { target: { value: "Fix the menu" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Give the task a title");
    fireEvent.click(create());
    expect(screen.queryByRole("alert")).toBeNull();
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

    // Typing leaves the message; sending again takes it away.
    fireEvent.change(titles(), { target: { value: "one" } });
    expect(screen.getByRole("alert")).toHaveTextContent("title is too long");
    fireEvent.click(create());
    expect(screen.queryByRole("alert")).toBeNull();
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

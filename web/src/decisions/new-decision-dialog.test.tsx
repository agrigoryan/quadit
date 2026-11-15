// @vitest-environment jsdom
// "Ask a question" (decisions/new-decision-dialog.tsx): checked before it is
// sent, the button off while the request is out, the server's refusal in the
// footer, and closed once the question is asked.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewDecisionDialog } from "@/decisions/new-decision-dialog";
import { api, ApiError } from "@/lib/api";
import { clearOutbox } from "@/lib/mutate";
import type { OutboxChange } from "@/lib/outbox";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
import { TooltipProvider } from "@/ui/tooltip";

interface Call {
  changes: OutboxChange[];
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
        const changes = (body as { changes: OutboxChange[] }).changes;
        calls.push({ changes, answer: () => resolve({ results: changes.map(() => ({})) }), fail: reject });
      }),
  );
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game" }],
    members: [
      { user_id: "u1", handle: "ann", name: "Ann" },
      { user_id: "u2", handle: "bo", name: "Bo" },
    ],
    tasks: [{ id: "t1", key: "SVA-1", title: "Menu", project_id: "p1", assignee_id: "u2" }],
  });
});

afterEach(async () => {
  await clearOutbox();
  for (const call of calls) call.fail(new Error("test over"));
  vi.restoreAllMocks();
});

function show() {
  const onClose = vi.fn();
  render(
    <TooltipProvider>
      <NewDecisionDialog taskId="t1" onClose={onClose} />
    </TooltipProvider>,
  );
  return onClose;
}

const ask = () => screen.getByRole("button", { name: "Ask Bo" });

function compose() {
  fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Which logo?" } });
  fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Round" } });
  fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Square" } });
}

describe("NewDecisionDialog", () => {
  it("sends nothing while the question or the options are missing, and says what to fix", () => {
    show();
    fireEvent.click(ask());
    expect(screen.getByText("Write the question first.")).toBeInTheDocument();
    expect(screen.getByText("A choice needs at least two options, each with a label.")).toBeInTheDocument();
    expect(ask()).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("drops a message once what it points at is fixed", () => {
    show();
    fireEvent.click(ask());
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Which logo?" } });
    expect(screen.queryByText("Write the question first.")).toBeNull();
    expect(screen.getByText("A choice needs at least two options, each with a label.")).toBeInTheDocument();
  });

  it("asks for a label on an option that has only a description", () => {
    show();
    compose();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Description (optional)")[2] as HTMLElement, {
      target: { value: "a third shape" },
    });
    fireEvent.click(ask());
    expect(screen.getByText("Give this option a label.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("turns the button off while the question is on its way, and sends it once for a double click", async () => {
    const onClose = show();
    compose();
    fireEvent.click(ask());
    fireEvent.click(ask());
    expect(ask()).toBeDisabled();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.changes[0]).toMatchObject({
      type: "decision.open",
      args: { task: "t1", question: "Which logo?", ask: "u2" },
    });
    await act(async () => calls[0]?.answer());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
  });

  it("sends with Cmd/Ctrl-Enter from any field", async () => {
    show();
    compose();
    fireEvent.keyDown(screen.getByLabelText("Option 2"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("shows the server's refusal in the footer and turns the button back on; the next try clears it", async () => {
    const onClose = show();
    compose();
    fireEvent.click(ask());
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.fail(new ApiError(400, { message: "the task is closed", field: "task" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("the task is closed");
    expect(ask()).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();

    // Typing leaves it; sending again takes it away.
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Which logo now?" } });
    expect(screen.getByRole("alert")).toHaveTextContent("the task is closed");
    fireEvent.click(ask());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

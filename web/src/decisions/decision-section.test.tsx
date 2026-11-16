// @vitest-environment jsdom
// D on the open task (decisions/decision-section.tsx): the focus goes to the
// options of the open question asked of me, and a short note says so when
// there is none. A question with pictures opens side by side instead (seen
// in the browser, e2e/keyboard.spec.ts).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { useToasts } from "@/lib/toast";
import type { Decision, Member, Task, User, Workspace } from "@/types/core";
import { DecisionSection } from "@/decisions/decision-section";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const task = { id: "t1", project_id: "p1", key: "SVA-1", title: "Pick a colour", number: 1, rank: "a" } as Task;

const question = (id: string, fields: Partial<Decision>): Decision =>
  ({
    id,
    task_id: "t1",
    kind: "choice",
    question: `Question ${id}`,
    state: "open",
    created_by: "agent",
    rank: id,
    options: [
      { id: `${id}-a`, label: "Blue" },
      { id: `${id}-b`, label: "Green" },
    ],
    ...fields,
  }) as Decision;

function seed(decisions: Decision[]) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "owner", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    members: [{ user_id: "agent", handle: "coder", name: "Coder", kind: "agent" }],
    tasks: [task],
    decisions,
  });
}

function show() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <DecisionSection taskId="t1" />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const pressD = () => act(() => void fireEvent.keyDown(document.body, { key: "d", code: "KeyD" }));
const toasts = () => useToasts.getState().items.map((item) => item.text);

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => useToasts.setState({ items: [] }));

describe("D", () => {
  it("puts the focus on the first option of the open question asked of me", () => {
    seed([question("d1", { asked_id: "u9" }), question("d2", { asked_id: "u1" })]);
    show();
    pressD();
    const asked = screen.getByRole("article", { name: "Question d2" });
    const blue = screen.getAllByRole("article", { name: "Blue" }).find((card) => asked.contains(card));
    expect(document.activeElement?.textContent).toBe("This one");
    expect(blue?.contains(document.activeElement)).toBe(true);
    expect(toasts()).toEqual([]);
  });

  it("says so when nothing open is asked of me", () => {
    seed([question("d1", { asked_id: "u9" }), question("d2", { asked_id: "u1", state: "picked" })]);
    show();
    pressD();
    expect(toasts()).toEqual(["No open question here waits on your answer"]);
  });
});

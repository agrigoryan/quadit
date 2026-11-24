// @vitest-environment jsdom
// A question no longer needed (decisions/decision-block.tsx, data.ts): who
// may say so (whoever asked or was asked, the person answering for the
// agent that asked, an admin) of a question open or sent back, with an
// optional note in place; such a question reads as history, and a question
// sent back reads as waiting on whoever asked it.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import { standingOf } from "@/decisions/data";
import { noteSaidBefore } from "@/decisions/decision-meta";
import { DecisionSection } from "@/decisions/decision-section";
import { WithQuery } from "@/test/query";
import type { Decision, Member, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

const task = { id: "t1", project_id: "p1", key: "SVA-1", title: "Pick a colour", number: 1, rank: "a" } as Task;
const ann = { user_id: "u1", handle: "ann", name: "Ann", role: "member", kind: "person" } as Member;
const bea = { user_id: "u2", handle: "bea", name: "Bea", role: "member", kind: "person" } as Member;
const boss = { user_id: "u3", handle: "boss", name: "Boss", role: "admin", kind: "person" } as Member;
const coder = {
  user_id: "a1",
  handle: "coder",
  name: "Coder",
  role: "member",
  kind: "agent",
  responsible_id: "u1",
} as Member;

const question = (fields: Partial<Decision> = {}): Decision =>
  ({
    id: "d1",
    task_id: "t1",
    kind: "choice",
    question: "Blue or green?",
    state: "open",
    created_by: "a1",
    asked_id: "u2",
    rank: "a",
    created_at: 1,
    options: [
      { id: "o1", label: "Blue" },
      { id: "o2", label: "Green" },
    ],
    ...fields,
  }) as Decision;

function show(me: Member, decision: Decision) {
  cleanup();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    members: [ann, bea, boss, coder],
    tasks: [task],
    decisions: [decision],
  });
  render(
    <MemoryRouter>
      <TooltipProvider>
        <DecisionSection taskId="t1" />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const card = () => screen.getByRole("article", { name: "Blue or green?" });
const closeButton = () => within(card()).queryByRole("button", { name: "No longer needed" });

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("No longer needed", () => {
  it.each([
    ["the one asked", bea],
    ["the person answering for the agent that asked", ann],
    ["an admin", boss],
  ])("is offered to %s, on a question open or sent back", (_, me) => {
    show(me, question());
    expect(closeButton()).toBeTruthy();
    show(me, question({ state: "sent_back", decided_by: "u2", outcome: "none", outcome_note: "Neither" }));
    expect(closeButton()).toBeTruthy();
  });

  it("is not offered to anyone else, nor on a question settled", () => {
    show(bea, question({ asked_id: "u9" }));
    expect(closeButton()).toBeNull();
    show(bea, question({ state: "picked", picked_option_id: "o1", decided_by: "u2" }));
    expect(closeButton()).toBeNull();
  });

  it("asks for an optional line in place, and closes the question with it", async () => {
    show(bea, question());
    fireEvent.click(closeButton() as HTMLElement);
    const note = within(card()).getByRole("textbox", { name: "Why, in a line (optional)" });
    fireEvent.change(note, { target: { value: " We picked a theme instead. " } });
    fireEvent.click(within(card()).getByRole("button", { name: "Mark no longer needed" }));
    await waitFor(() =>
      expect(sent).toEqual([{ type: "decision.close", args: { id: "d1", note: "We picked a theme instead." } }]),
    );
    expect(within(card()).getByText("No longer needed")).toBeTruthy();
  });

  it("closes it without a note, and Cancel leaves it as it was", async () => {
    show(bea, question());
    fireEvent.click(closeButton() as HTMLElement);
    fireEvent.click(within(card()).getByRole("button", { name: "Cancel" }));
    expect(within(card()).queryByRole("textbox", { name: "Why, in a line (optional)" })).toBeNull();
    fireEvent.click(closeButton() as HTMLElement);
    fireEvent.click(within(card()).getByRole("button", { name: "Mark no longer needed" }));
    await waitFor(() => expect(sent).toEqual([{ type: "decision.close", args: { id: "d1" } }]));
  });

  it("reads as history once closed: its state, who said so and why, and no options to pick", () => {
    show(bea, question({ state: "not_needed", decided_by: "u2", decided_at: 5, outcome_note: "Cut from the game." }));
    expect(within(card()).getByText("No longer needed")).toBeTruthy();
    expect(within(card()).getByText(/marked it no longer needed/)).toBeTruthy();
    expect(within(card()).getByText("Cut from the game.")).toBeTruthy();
    expect(within(card()).queryByRole("article", { name: "Blue" })).toBeNull();
    expect(closeButton()).toBeNull();
  });

  it("says a question sent back waits on whoever asked it", () => {
    show(bea, question({ state: "sent_back", decided_by: "u2", outcome: "none", outcome_note: "Neither" }));
    expect(within(card()).getByText(/^Waiting on/).textContent).toBe("Waiting on C@coder to ask again or carry on.");
  });
});

describe("a question closed, read true", () => {
  it("names nobody when nobody is known to have closed it, only that it is no longer needed and when", () => {
    show(bea, question({ state: "not_needed", decided_at: 5 }));
    expect(within(card()).getAllByText("No longer needed")).toHaveLength(2);
    expect(within(card()).queryByText(/marked it no longer needed/)).toBeNull();
  });

  it("tells the words it was sent back with from a reason given when it was closed", () => {
    const row = (state: string, note: string, seq: number) => ({
      seq,
      at: seq,
      actor_id: "u2",
      change_id: `c${seq}`,
      type: `decision.${state}`,
      entity_type: "decision",
      entity_id: "d1",
      scope_type: "",
      scope_id: "",
      data: { row: { id: "d1", outcome_note: note } },
    });
    const kept = { id: "d1", outcome_note: "Neither of these" };
    expect(noteSaidBefore([row("picked", "Neither of these", 3), row("closed", "Neither of these", 5)], kept)).toBe(
      true,
    );
    expect(
      noteSaidBefore([row("picked", "Neither of these", 3), row("closed", "Cut it", 5)], {
        ...kept,
        outcome_note: "Cut it",
      }),
    ).toBe(false);
    // Without its history the note is shown as it is.
    expect(noteSaidBefore([], kept)).toBe(false);
  });
});

describe("where a question stands", () => {
  it.each([
    ["open, asked of me", { state: "open", asked_id: "u1", created_by: "u2" }, "yours"],
    ["open, asked of another", { state: "open", asked_id: "u2", created_by: "u1" }, "others"],
    ["open, asked of anyone", { state: "open", created_by: "u2" }, "others"],
    ["sent back to me, its asker", { state: "sent_back", asked_id: "u2", created_by: "u1" }, "yours"],
    ["sent back by me to its asker", { state: "sent_back", asked_id: "u1", created_by: "u2" }, "others"],
    ["picked", { state: "picked", asked_id: "u1", created_by: "u2" }, "settled"],
    ["no longer needed", { state: "not_needed", asked_id: "u1", created_by: "u2" }, "settled"],
  ] as const)("%s", (_, decision, standing) => {
    expect(standingOf(decision, "u1")).toBe(standing);
  });
});

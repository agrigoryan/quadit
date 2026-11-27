// @vitest-environment jsdom
// The epic dialog (plan/epic-dialog.tsx): its start and target are picked in
// the date picker, the target may not go before the start, each month shows
// the days between them, and either can be cleared.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import { formatDay, fullDay } from "@/lib/time";
import type { Epic, Member, User, Workspace } from "@/types/core";
import { EpicDialog } from "@/insights/plan/epic-dialog";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

const EPIC: Epic = {
  id: "e1",
  project_id: "p1",
  name: "Launch",
  state: "active",
  rank: "a",
  start_on: "2026-12-01",
  target_on: "2026-12-18",
  created_by: "u1",
  created_at: 0,
  updated_at: 0,
  updated_seq: 1,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 26, 12), toFake: ["Date"] });
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  const me = { user_id: "u1", role: "owner", name: "Me", kind: "person", handle: "me" } as Member;
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    epics: [EPIC],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await clearOutbox();
  vi.restoreAllMocks();
});

function show(epic?: Epic) {
  render(
    <TooltipProvider>
      <EpicDialog projectId="p1" epic={epic} onClose={() => {}} />
    </TooltipProvider>,
  );
}

/** Types words into an open date picker and takes them with Enter. */
function typeDay(picker: HTMLElement, words: string) {
  const box = within(picker).getByRole("textbox");
  fireEvent.change(box, { target: { value: words } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("the epic dialog's dates", () => {
  it("are picked in the date picker and sent with the new epic, whether or not its maker asks for its id", async () => {
    show();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Start: No date" }));
    typeDay(screen.getByRole("dialog", { name: "Start" }), "dec 1 2026");
    fireEvent.click(screen.getByRole("button", { name: "Target: No date" }));
    typeDay(screen.getByRole("dialog", { name: "Target" }), "dec 18 2026");
    fireEvent.click(screen.getByRole("button", { name: "Create epic" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.args).toMatchObject({ name: "Beta", start_on: "2026-12-01", target_on: "2026-12-18" });
  });

  it("keep the target from going before the start, and show the days between", () => {
    show(EPIC);
    fireEvent.click(screen.getByRole("button", { name: `Target: ${formatDay("2026-12-18")}` }));
    const picker = screen.getByRole("dialog", { name: "Target" });
    const dayButton = (day: string) => within(picker).getByRole("button", { name: new RegExp(`^${fullDay(day)}`) });
    expect(dayButton("2026-11-30")).toBeDisabled();
    expect(dayButton("2026-12-01").closest("td")).toHaveClass("bg-accent-soft");
    expect(dayButton("2026-12-10").closest("td")).toHaveClass("bg-accent-soft");
    expect(dayButton("2026-12-19").closest("td")).not.toHaveClass("bg-accent-soft");
  });

  it("clear a date, and send it cleared", async () => {
    show(EPIC);
    fireEvent.click(screen.getByRole("button", { name: `Start: ${formatDay("2026-12-01")}` }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Start" })).getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Start: No date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.args).toMatchObject({ id: "e1", start_on: null });
  });
});

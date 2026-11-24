// @vitest-environment jsdom
// The inbox (pages/inbox.tsx) in its two tabs: Needs you, what was meant for
// me, first and shown at the start; Updates, what I hear of as a follower.
// Each tab has its unread count and its own Mark all read; an empty Needs
// you says so and leads to the updates that wait; the tab last shown is
// kept for the browser tab's session.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import { InboxPage } from "@/pages/inbox";
import type { Member, Notification, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const bea = { user_id: "u2", role: "member", name: "Bea", kind: "person", handle: "bea" } as Member;

const item = (id: string, over: Partial<Notification>): Notification => ({
  id,
  user_id: "u1",
  seq: Number(id.slice(1)),
  type: "comment",
  actor_id: "u2",
  created_at: 1,
  title: `SVA-${id.slice(1)} Task ${id}`,
  ...over,
});

function show(notifications: Notification[]) {
  cleanup();
  clearStore();
  loadBootstrap("acme", {
    seq: 100,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    members: [me, bea],
    notifications,
  });
  render(
    <MemoryRouter>
      <TooltipProvider>
        <InboxPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const rows = () =>
  within(screen.getByRole("tabpanel"))
    .queryAllByRole("link")
    .map((l) => l.getAttribute("aria-label"));

const mixed = [
  item("n1", { type: "mentioned", addressed: true }),
  item("n2", { type: "decision_asked", addressed: true, read_at: 5 }),
  item("n3", { type: "comment" }),
  item("n4", { type: "status" }),
  item("n5", { type: "result", read_at: 5 }),
];

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const { changes } = body as { changes: Sent[] };
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  sessionStorage.clear();
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("the inbox's two tabs", () => {
  it("opens on Needs you, with what was meant for me, and each tab's unread count", () => {
    show(mixed);
    expect(screen.getByRole("tablist", { name: "Inbox" })).toBeTruthy();
    expect(tab(/^Needs you/).getAttribute("aria-selected")).toBe("true");
    expect(tab(/^Needs you/).textContent).toBe("Needs you1");
    expect(tab(/^Updates/).textContent).toBe("Updates2");
    expect(rows()).toEqual([expect.stringMatching(/^@bea asked you/), expect.stringMatching(/^@bea mentioned you/)]);
    expect(screen.getByText("1 unread")).toBeTruthy();
  });

  it("shows the updates I follow in Updates", () => {
    show(mixed);
    fireEvent.mouseDown(tab(/^Updates/));
    fireEvent.click(tab(/^Updates/));
    expect(tab(/^Updates/).getAttribute("aria-selected")).toBe("true");
    expect(rows()).toEqual([
      expect.stringMatching(/^@bea posted a result/),
      expect.stringMatching(/^@bea changed the status/),
      expect.stringMatching(/^@bea commented/),
    ]);
    expect(screen.getByText("2 unread")).toBeTruthy();
  });

  it("marks read only what the tab shows", async () => {
    show(mixed);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() =>
      expect(sent).toEqual([{ type: "notification.read", args: { all: true, addressed: true, up_to: 2 } }]),
    );
    expect(tab(/^Updates/).textContent).toBe("Updates2");
  });

  it("says nothing needs me, and leads to the unread updates", () => {
    show([item("n3", {}), item("n4", { type: "status" })]);
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 unread updates" }));
    expect(tab(/^Updates/).getAttribute("aria-selected")).toBe("true");
    expect(rows()).toHaveLength(2);
  });

  it("says a question of mine was closed as no longer needed, with the closer's note alone", () => {
    show([item("n7", { type: "not_needed", addressed: true, snippet: "no longer needed: We cut the double jump." })]);
    expect(rows()).toEqual([expect.stringMatching(/^@bea marked your question no longer needed\./)]);
    expect(screen.getAllByText("We cut the double jump.").length).toBeGreaterThan(0);
  });

  it("opens again on the tab last shown, for this session", () => {
    show([item("n3", {})]);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 unread update" }));
    show(mixed);
    expect(tab(/^Updates/).getAttribute("aria-selected")).toBe("true");
  });
});

// @vitest-environment jsdom
// The sidebar's Inbox (shell/sidebar.tsx): a number for what needs me,
// unread; with only updates unread, a quiet dot that says how many; nothing
// when everything is read.

import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import { Sidebar } from "@/shell/sidebar";
import { WithQuery } from "@/test/query";
import type { Member, Notification, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const item = (id: string, over: Partial<Notification> = {}): Notification => ({
  id,
  user_id: "u1",
  seq: 1,
  type: "comment",
  actor_id: "u2",
  created_at: 1,
  ...over,
});

function show(notifications: Notification[]) {
  cleanup();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    notifications,
  });
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <Sidebar />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

const inbox = () => screen.getByRole("link", { name: /^Inbox/ });

beforeEach(() => clearStore());

describe("the sidebar's Inbox", () => {
  it("counts only what needs me, unread", () => {
    show([
      item("n1", { addressed: true }),
      item("n2", { addressed: true }),
      item("n3"),
      item("n4", { addressed: true, read_at: 2 }),
    ]);
    expect(inbox().textContent).toBe("Inbox2");
    expect(within(inbox()).queryByRole("img")).toBeNull();
  });

  it("shows a quiet dot, said as how many updates are unread, when only updates are", () => {
    show([item("n3"), item("n5"), item("n4", { addressed: true, read_at: 2 })]);
    expect(inbox().textContent).toBe("Inbox");
    expect(within(inbox()).getByRole("img", { name: "2 unread updates" })).toBeTruthy();
  });

  it("shows nothing when everything is read", () => {
    show([item("n3", { read_at: 2 }), item("n4", { addressed: true, read_at: 2 })]);
    expect(inbox().textContent).toBe("Inbox");
    expect(within(inbox()).queryByRole("img")).toBeNull();
  });
});

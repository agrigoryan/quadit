// @vitest-environment jsdom
// The Agents page (insights/agents/agents-page.tsx) in the desktop app that
// can connect agent tools: a button in its header and, with no agents yet,
// as the empty state's main action, that opens the app's Connect window.
// In a browser, or an app without that call, the page is as it always was.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { AgentsPage } from "@/insights/agents/agents-page";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "owner", name: "Me", kind: "person", handle: "me" } as Member;
const bot = { user_id: "a1", role: "member", name: "Claude Code", kind: "agent", handle: "claude" } as Member;
const connect = "Connect a tool on this computer";
// With the title "No agents yet" above it, the empty state says §8's sentence.
const connectHint = "Connect Claude Code, Codex or another tool on this computer, and it becomes a member here.";

function show(members: Member[]) {
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members,
  });
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <AgentsPage />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

/** The bridge of an app whose version may lack openConnect. */
const bridge = (more: Partial<QuaditDesktop> = {}): QuaditDesktop => ({
  version: "0.1.0",
  notify: () => {},
  setBadge: () => {},
  ...more,
});

beforeEach(() => {
  clearStore();
  vi.spyOn(api, "get").mockResolvedValue({ agents: [], sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.quaditDesktop;
});

describe("AgentsPage in the desktop app that connects tools", () => {
  it("opens the app's Connect window from the header, once a click", async () => {
    const openConnect = vi.fn();
    window.quaditDesktop = bridge({ openConnect });
    show([me, bot]);
    await userEvent.click(screen.getByRole("button", { name: connect }));
    expect(openConnect).toHaveBeenCalledTimes(1);
  });

  it("makes connecting a tool the empty state's main action", async () => {
    const openConnect = vi.fn();
    window.quaditDesktop = bridge({ openConnect });
    show([me]);
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByText(connectHint)).toBeTruthy();
    // The way through Settings stays, after it.
    expect(screen.getByRole("link", { name: "Add an agent in Settings" })).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: connect });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(openConnect).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["a browser", undefined],
  ["an app without openConnect", bridge()],
])("AgentsPage in %s", (_, desktop) => {
  it("offers no Connect and keeps its empty state", () => {
    window.quaditDesktop = desktop;
    show([me]);
    expect(screen.queryByRole("button", { name: connect })).toBeNull();
    expect(screen.queryByText(connectHint)).toBeNull();
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add an agent in Settings" })).toBeTruthy();
  });
});

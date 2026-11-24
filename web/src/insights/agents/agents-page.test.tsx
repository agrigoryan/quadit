// @vitest-environment jsdom
// The Agents page (insights/agents/agents-page.tsx): one way to add an agent,
// in its header and, with no agents yet, as the empty state's main action.
// In the desktop app it opens the app's Connect window; in a browser, or an
// app without that call, an admin makes one with Settings' dialog. And an
// agent whose computer is offline, said as Settings says it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { AgentsPage } from "@/insights/agents/agents-page";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import type { QuaditDesktop } from "@/types/desktop";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "owner", name: "Me", kind: "person", handle: "me" } as Member;
const bot = { user_id: "a1", role: "member", name: "Claude Code", kind: "agent", handle: "claude" } as Member;
const add = "Add an agent";
// With the title "No agents yet" above it, the empty state says §8's sentence.
const connectHint = "Connect Claude Code, Codex or another AI tool on this computer, and it becomes a member here.";

function show(members: Member[], viewer: Member = me) {
  loadBootstrap("acme", {
    seq: 1,
    me: viewer,
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

beforeAll(() => {
  // The dialog's fields measure themselves; jsdom has nothing to measure with.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  clearStore();
  vi.spyOn(api, "get").mockResolvedValue({ agents: [], sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.quaditDesktop;
});

describe("Add an agent, in the desktop app that connects tools", () => {
  it("opens the app's Connect window from the header, on no one agent, once a click", async () => {
    const openConnect = vi.fn();
    window.quaditDesktop = bridge({ openConnect });
    show([me, bot]);
    await userEvent.click(screen.getByRole("button", { name: add }));
    expect(openConnect.mock.calls).toEqual([[undefined]]);
  });

  it("is the empty state's main action too", async () => {
    const openConnect = vi.fn();
    window.quaditDesktop = bridge({ openConnect });
    show([me]);
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByText(connectHint)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: add });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(openConnect).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["a browser", undefined],
  ["an app without openConnect", bridge()],
])("Add an agent, in %s", (_, desktop) => {
  it("makes one with Settings' dialog, for an admin", async () => {
    window.quaditDesktop = desktop;
    show([me]);
    expect(screen.queryByText(connectHint)).toBeNull();
    expect(screen.getByText("No agents yet")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: add })[0]!);
    expect(await screen.findByRole("dialog", { name: "New agent" })).toBeTruthy();
  });

  it("is not there for a member, who may not make agents", () => {
    window.quaditDesktop = desktop;
    show([{ ...me, role: "member" }, bot], { ...me, role: "member" });
    expect(screen.queryByRole("button", { name: add })).toBeNull();
  });
});

describe("an agent whose computer is offline", () => {
  it("says what runs it and since when it is offline, as Settings does, not that nothing listens", async () => {
    const away = {
      project_id: "p1",
      project: "SVA",
      by: "Quadit's runner",
      live: false,
      runner: {
        machine: "Aram's Mac",
        folder: "~/game",
        program: "claude",
        program_version: "2",
        holding: false,
        since: "2026-11-24 14:02",
      },
    };
    const state = {
      handle: "claude",
      name: "Claude Code",
      user_id: "a1",
      state: "idle",
      connected_at: "2026-11-24 10:00",
      listening: false,
      listeners: [away],
      listening_projects: [],
      listening_outside_projects: false,
      open_tasks: 0,
      waiting_on_it: 0,
    };
    vi.spyOn(api, "get").mockResolvedValue({ agents: [state], sessions: [] });
    show([me, bot]);
    expect(
      await screen.findByText(/^Runs SVA on Aram's Mac: offline since .+\. Its requests wait for it\.$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/listening/i)).toBeNull();
  });
});

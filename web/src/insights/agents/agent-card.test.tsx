// @vitest-environment jsdom
// An agent's card on the Agents page (insights/agents/agent-card.tsx): the
// one thing to do about its state, in the desktop app and in a browser;
// where it lives; its name leading to its settings; and its menu, by what
// the viewer may do and what this computer connects.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import { AgentCard } from "@/insights/agents/agent-card";
import { NO_WORK } from "@/insights/agents/agent-data";
import { WithQuery } from "@/test/query";
import type { AgentSession, Member, Task, User, Workspace } from "@/types/core";
import type { AgentState, ListenerShown } from "@/types/dashboard";
import type { QuaditDesktop } from "@/types/desktop";
import type { LocalAgent } from "@/ui/desktop-agents";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member;
const bea = { user_id: "u2", handle: "bea", name: "Bea", kind: "person", role: "member" } as Member;
const claude = {
  user_id: "a1",
  handle: "claude",
  name: "Claude",
  kind: "agent",
  role: "member",
  responsible_id: "u1",
} as Member;
const task = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss fight" } as Task;

const runner: ListenerShown = {
  project_id: "p1",
  project: "SVA",
  by: "Quadit's runner",
  live: true,
  runner: {
    machine: "Aram's Mac",
    folder: "~/game",
    program: "claude",
    program_version: "2",
    holding: true,
    since: "",
  },
};

/** The agent as the server reads it: connected through Claude Code unless told otherwise, nothing listening. */
const reading = (over: Partial<AgentState> = {}): AgentState => ({
  handle: "claude",
  name: "Claude",
  user_id: "a1",
  state: "idle",
  connected_at: "2026-11-24 10:00",
  tool: "Claude Code",
  listening: false,
  listeners: [],
  listening_projects: [],
  listening_outside_projects: false,
  open_tasks: 0,
  waiting_on_it: 0,
  ...over,
});
const listening = (listener: ListenerShown) =>
  reading({ listening: true, listeners: [listener], listening_projects: ["p1"] });

const here = (over: Partial<LocalAgent> = {}): LocalAgent => ({
  agent: "a1",
  program: "claude",
  programName: "Claude Code",
  computer: "Aram's Mac",
  canRun: true,
  runs: [],
  ...over,
});

let open: ReturnType<typeof vi.fn>;

function show(
  state: AgentState,
  app: Record<string, LocalAgent> | null,
  more: { me?: Member; sessions?: AgentSession[] } = {},
) {
  cleanup();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: more.me ?? ann,
    user: { id: (more.me ?? ann).user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    members: [ann, bea, claude],
    tasks: [task],
  });
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <AgentCard
            member={claude}
            state={state}
            work={NO_WORK}
            sessions={more.sessions ?? []}
            resourceNames={{}}
            app={app}
            now={Date.UTC(2026, 10, 24, 12)}
          />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

const card = () => screen.getByRole("article", { name: "Claude" });
const buttons = () =>
  within(card())
    .queryAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

beforeEach(() => {
  open = vi.fn();
  window.quaditDesktop = { version: "1", notify: () => {}, setBadge: () => {}, openConnect: open } as QuaditDesktop;
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
  delete window.quaditDesktop;
});

describe("the card in the app, in the app's card's words", () => {
  it("says it is not connected, and connects it in the app's Connect window", () => {
    show(reading({ connected_at: undefined, tool: undefined }), {});
    expect(within(card()).getByText("Not connected")).toBeTruthy();
    expect(within(card()).queryByText("Connected")).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Connect" }));
    expect(open).toHaveBeenCalledWith({ agent: "a1", intent: "connect" });
  });

  it("says in one line that it is connected and not listening, with the words to say, and Run by Quadit where this computer can", async () => {
    show(reading(), { a1: here() });
    expect(within(card()).getByText("Connected")).toBeTruthy();
    expect(within(card()).getByText("Not listening. Say “listen to Quadit” to it in a chat.")).toBeTruthy();
    // What running it means is said in the app's sheet of the agent, not on the card.
    expect(within(card()).queryByText(/^Quadit can start/)).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Run by Quadit…" }));
    expect(open).toHaveBeenCalledWith({ agent: "a1", intent: "run" });
    // Copying gives the words alone.
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    fireEvent.click(within(card()).getByRole("button", { name: "Copy “listen to Quadit”" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("listen to Quadit"));

    show(reading(), { a1: here({ canRun: false }) });
    expect(within(card()).queryByRole("button", { name: "Run by Quadit…" })).toBeNull();
  });

  it("says what Quadit runs on this computer and how it stands, and stops it in the app's Connect window", () => {
    show(listening(runner), { a1: here({ runs: ["p1"] }) });
    expect(within(card()).getByText("Runs SVA in ~/game.")).toBeTruthy();
    expect(within(card()).getByText("Ready.")).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: "Stop running SVA on this computer" }));
    expect(open).toHaveBeenCalledWith({ agent: "a1", intent: "run" });
    show(listening({ ...runner, runner: { ...runner.runner!, task: "SVA-4" } }), { a1: here({ runs: ["p1"] }) });
    expect(within(card()).getByText("Working on SVA-4.")).toBeTruthy();
    show(listening({ ...runner, runner: { ...runner.runner!, paused: "not_signed_in" } }), {
      a1: here({ runs: ["p1"] }),
    });
    expect(
      within(card()).getByText("Paused: Claude Code is not signed in. Open Claude Code and sign in."),
    ).toBeTruthy();
    show(listening({ ...runner, runner: { ...runner.runner!, holding: false } }), { a1: here({ runs: ["p1"] }) });
    expect(
      within(card()).getByText("A chat listens to SVA now. Quadit runs it again when that chat stops."),
    ).toBeTruthy();
  });

  it("says that a chat listens, with Run by Quadit at the end of its line, and that another computer runs it, with nothing to press", () => {
    show(listening({ project_id: "p1", project: "SVA", by: "a chat", live: true }), { a1: here() });
    expect(within(card()).getByText("Listening to Game, from a chat")).toBeTruthy();
    expect(within(card()).queryByText(/^It answers/)).toBeNull();
    expect(buttons()).toEqual(["More for Claude", "Run by Quadit…"]);
    show(listening(runner), null);
    expect(within(card()).getByText("Quadit runs SVA on Aram's Mac.")).toBeTruthy();
    expect(buttons()).toEqual(["More for Claude"]);
  });

  it("offers Stop on the run in hand, once, and nothing else", () => {
    const run: AgentSession = {
      id: "s1",
      agent_id: "a1",
      task_id: "t1",
      title: "Boss fight",
      state: "running",
      machine_id: "0123456789abcdef",
      machine_name: "Aram's Mac",
      started_at: 1,
      updated_seq: 1,
    };
    show(
      listening({ ...runner, runner: { ...runner.runner!, task: "SVA-1" } }),
      { a1: here({ runs: ["p1"] }) },
      {
        sessions: [run],
      },
    );
    expect(within(card()).getAllByRole("button", { name: "Stop @claude's run on SVA-1" })).toHaveLength(1);
    expect(within(card()).queryByRole("button", { name: /^Stop running/ })).toBeNull();
  });

  it("offers Connect only to whoever may make the agent a connect code", () => {
    show(reading({ connected_at: undefined, tool: undefined }), {}, { me: bea });
    expect(within(card()).queryByRole("button", { name: "Connect" })).toBeNull();
  });
});

describe("the card in a browser", () => {
  beforeEach(() => {
    delete window.quaditDesktop;
  });

  it("leads to the agent's page in Settings to connect it there", () => {
    show(reading({ connected_at: undefined, tool: undefined }), null);
    expect(within(card()).getByRole("link", { name: "Connect" }).getAttribute("href")).toBe(
      "/acme/settings/agents/claude",
    );
  });

  it("gives the words to write, with no Run by Quadit, no Stop running and no Disconnect", () => {
    show(reading(), null);
    expect(within(card()).getByText("Not listening. Say “listen to Quadit” to it in a chat.")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Run by Quadit…" })).toBeNull();
    show(listening(runner), null);
    expect(within(card()).queryByRole("button", { name: /^Stop running/ })).toBeNull();
  });

  it("is the same in an app whose word on this computer's agents failed", () => {
    window.quaditDesktop = { version: "1", notify: () => {}, setBadge: () => {}, openConnect: open } as QuaditDesktop;
    show(reading({ connected_at: undefined, tool: undefined }), null);
    expect(within(card()).getByRole("link", { name: "Connect" })).toBeTruthy();
  });
});

describe("where the agent lives", () => {
  const where = () => within(card()).queryByText(/^(Claude Code|Codex)/);

  it("names its program and the computer a runner or this app says", () => {
    show(listening(runner), null);
    expect(where()?.textContent).toBe("Claude Code on Aram's Mac");
    show(reading({ tool: undefined }), { a1: here({ programName: "Codex", computer: "Bea's PC" }) });
    expect(where()?.textContent).toBe("Codex on Bea's PC");
  });

  it("names the program alone when no computer is known, and nothing when neither is", () => {
    show(reading(), null);
    expect(where()?.textContent).toBe("Claude Code");
    show(reading({ tool: undefined }), null);
    expect(where()).toBeNull();
  });

  it("opens the agent's settings from its name", () => {
    show(reading(), null);
    expect(within(card()).getByRole("link", { name: "Claude" }).getAttribute("href")).toBe(
      "/acme/settings/agents/claude",
    );
  });
});

describe("the card's menu", () => {
  const items = () => {
    // Radix opens a menu on a pointer press jsdom does not make; a key opens it as well.
    fireEvent.keyDown(within(card()).getByRole("button", { name: "More for Claude" }), { key: "ArrowDown" });
    return within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((m) => m.textContent);
  };

  it("offers an admin the settings, disconnecting it where this computer connects it, and removing it", () => {
    show(reading(), { a1: here() });
    expect(items()).toEqual(["Settings", "Disconnect from this computer", "Remove agent"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect from this computer" }));
    expect(open).toHaveBeenCalledWith({ agent: "a1", intent: "disconnect" });
  });

  it("offers a member no Remove, and a browser no Disconnect", () => {
    show(reading(), { a1: here() }, { me: bea });
    expect(items()).toEqual(["Settings", "Disconnect from this computer"]);
    show(reading(), null);
    expect(items()).toEqual(["Settings", "Remove agent"]);
  });

  it("removes the agent after asking, as Settings does", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
    show(reading(), null);
    items();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[1] as { changes: { type: string; args: unknown }[] };
    expect(body.changes.map(({ type, args }) => ({ type, args }))).toEqual([
      { type: "member.remove", args: { id: "a1" } },
    ]);
  });
});

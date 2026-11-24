// @vitest-environment jsdom
// A session's line (insights/agents/session-row.tsx) and the task's list of
// them (insights/task-work.tsx): the state first, in words; for a run
// Quadit's runner started, its computer, why it waits, did not start or
// failed and what to do; Stop for whoever may change the task while the run
// is open; the line that continues its session, only for the agent's
// responsible person on its newest ended run; a run done that waits for
// the answer to the question its agent asked since; and, opened, who
// started it and what it did, in words, never as JSON.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, loadBootstrap } from "@/data/store";
import { SessionRow } from "@/insights/agents/session-row";
import { TaskWork } from "@/insights/task-work";
import { WithQuery } from "@/test/query";
import type { AgentSession, Decision, Member, SessionState, Task, User, Workspace } from "@/types/core";
import { TooltipProvider } from "@/ui/tooltip";

const now = Date.UTC(2026, 10, 24, 12, 0);
const id = "0f8e7d6c-5b4a-4321-9fed-cba987654321";

const ann = { user_id: "u1", handle: "ann", name: "Ann", kind: "person", role: "owner" } as Member;
const bea = { user_id: "u2", handle: "bea", name: "Bea", kind: "person", role: "member" } as Member;
const claude = { user_id: "a1", handle: "claude", name: "Claude", kind: "agent", role: "member", responsible_id: "u1" };
const task = { id: "t1", key: "SVA-12", project_id: "p1", status_id: "s1", title: "Boss fight" } as Task;

/** The store as `me` sees it (Ann by default, the owner and @claude's responsible person). */
function load(me: Member = ann, more: { sessions?: AgentSession[]; decisions?: Decision[] } = {}) {
  cleanup();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Game", rank: "a" },
      { id: "p2", key: "GS", name: "Other", rank: "b" },
    ],
    members: [ann, bea, claude],
    tasks: [task],
    sessions: more.sessions ?? [],
    decisions: more.decisions ?? [],
  });
}

/** A run Quadit's runner started on Aram's MacBook Pro, with Claude Code. */
const run = (state: SessionState, over: Partial<AgentSession> = {}): AgentSession => ({
  id: "s1",
  agent_id: "a1",
  task_id: "t1",
  title: "Boss fight",
  state,
  started_at: now - 5 * 60_000,
  updated_seq: 1,
  program: "claude",
  program_session: id,
  machine_id: "0123456789abcdef",
  machine_name: "Aram's MacBook Pro",
  folder: "~/devel/game",
  ...(state === "waiting" || state === "running" ? {} : { ended_at: now - 60_000 }),
  ...over,
});

function wrap(children: React.ReactNode) {
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>{children}</TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

function show(session: AgentSession, props: { newestRun?: boolean } = {}) {
  wrap(
    <ul>
      <SessionRow session={session} now={now} {...props} />
    </ul>,
  );
}

const expand = () => fireEvent.click(screen.getByRole("button", { name: /^Show what/ }));

beforeEach(() => load());

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

describe("a session's state", () => {
  it.each([
    ["waiting", "Waiting"],
    ["running", "Working"],
    ["done", "Done"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
    ["not_started", "Not started"],
  ] as const)("shows a %s session as %s", (state, word) => {
    show(run(state, { reason: "" }));
    expect(screen.getByText(word)).toBeInTheDocument();
  });

  it("says when a session an agent recorded itself started, while it is open", () => {
    show(run("running", { machine_id: undefined, machine_name: undefined }));
    expect(screen.getByText("started 5m")).toBeInTheDocument();
    expect(screen.queryByText("Aram's MacBook Pro")).toBeNull();
  });

  it("names a runner's computer and when it received the run, or how long it has worked", () => {
    show(run("waiting"));
    expect(screen.getByText("Aram's MacBook Pro")).toBeInTheDocument();
    expect(screen.getByText("received 5m")).toBeInTheDocument();
  });

  it("counts how long a run has worked from when the program took the prompt", () => {
    show(run("running", { accepted_at: now - 3 * 60_000 }));
    expect(screen.getByText("for 3m")).toBeInTheDocument();
    show(run("running", { accepted_at: now - 20_000 }));
    expect(screen.getByText("for under a minute")).toBeInTheDocument();
  });
});

describe("what a run did", () => {
  const lines = () =>
    within(screen.getByRole("heading", { name: "What it did" }).parentElement as HTMLElement)
      .getAllByRole("listitem")
      .map((li) => li.textContent);

  it("shows the agent's words, and folds the commands between them into one line each", () => {
    const words = (text: string) => ({ text, at: 1 });
    const shell = { tool: "shell", at: 1 };
    show(
      run("done", {
        program: "codex",
        steps: [words("I'll list the files under `src`."), shell, shell, words("I'll write `summary.txt`."), shell],
      }),
    );
    expand();
    expect(lines()).toEqual([
      "I'll list the files under src.",
      "Ran 2 commands",
      "I'll write summary.txt.",
      "Ran a command",
    ]);
    expect(screen.getByText("summary.txt").tagName).toBe("CODE");
  });

  it("gives a tool its plain name beside what the program said it does", () => {
    show(
      run("done", {
        steps: [
          { text: "Listing files under src.", at: 1 },
          { tool: "Bash", text: "Count lines in every file under src", at: 1 },
          { tool: "Write", text: "summary.txt", at: 1 },
          { tool: "edit", text: "update README.md", at: 1 },
        ],
      }),
    );
    expand();
    expect(lines()).toEqual([
      "Listing files under src.",
      "Count lines in every file under srcCommand",
      "summary.txtWrite",
      "update README.mdEdit",
    ]);
  });

  it("folds tool steps that say nothing by their kind, and says how many times", () => {
    const step = (tool: string) => ({ tool, at: 1 });
    show(
      run("done", {
        steps: [
          step("shell"),
          step("Bash"),
          step("web search"),
          step("web search"),
          step("Read"),
          step("quadit.task_get"),
        ],
      }),
    );
    expand();
    expect(lines()).toEqual(["Ran 2 commands", "Searched the web 2 times", "Used Read", "Used quadit.task_get"]);
  });

  it("never shows a step as JSON: a string of it, or nothing; old steps of plain strings read as they are", () => {
    show(
      run("done", {
        steps: ["drew a line", { anything: [1, 2] }, 7, { name: "Looked around" }, { tool: "Read", text: "" }],
      }),
    );
    expand();
    expect(lines()).toEqual(["drew a line", "Looked around", "Used Read"]);
    expect(document.body.textContent).not.toContain("{");
  });

  it("says who started a run Quadit's runner started, and what an agent's own session was asked", () => {
    show(run("done", { instructions: '@ann commented: "check this out"' }));
    expand();
    expect(screen.getByRole("heading", { name: "Started by" })).toBeInTheDocument();
    expect(screen.getByText('@ann commented: "check this out"')).toBeInTheDocument();
    show(run("done", { machine_id: undefined, machine_name: undefined, instructions: "Fix the login bug" }));
    expand();
    expect(screen.getByRole("heading", { name: "Asked to" })).toBeInTheDocument();
  });

  it("shows a link by a string of it, and leaves out one with none", () => {
    show(run("done", { links: ["https://example.com/pr/1", { ref: "abc123" }, { size: 3 }] }));
    expand();
    const produced = within(screen.getByRole("heading", { name: "Produced" }).parentElement as HTMLElement);
    expect(produced.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["example.com/pr/1", "abc123"]);
  });
});

describe("why a run waits, did not start or failed", () => {
  it.each([
    ["folder_busy", "waiting", "Waiting for the folder: another run works there.", "It starts when that run ends."],
    [
      "not_responsible",
      "not_started",
      "Not started: only Ann's words, or their agents', start @claude on Aram's MacBook Pro.",
      "Ask Ann to comment here, or assign the task to an agent of your own.",
    ],
    [
      "run_open",
      "not_started",
      "Not started: a run of @claude on this task is still open on another computer.",
      "Stop that run; then Ann can write to @claude here to start it again.",
    ],
    [
      "run_cap",
      "not_started",
      "Not started: other agents started @claude too often in the last hour.",
      "Ann can write to @claude here to start it again.",
    ],
    [
      "no_progress",
      "not_started",
      "Not started: the last two runs changed nothing on this task.",
      "Ann can write to @claude here to start it again.",
    ],
    [
      "start_failed",
      "failed",
      "Failed: Claude Code did not start on Aram's MacBook Pro.",
      "Quadit's runner log on Aram's MacBook Pro says why. Comment to try again.",
    ],
    [
      "idle",
      "failed",
      "Failed: Claude Code printed nothing for 30 minutes, so Quadit stopped it.",
      "Comment to go on in the same session.",
    ],
    [
      "interrupted",
      "failed",
      "Interrupted: Quadit stopped on Aram's MacBook Pro, or another session took the project, while @claude worked.",
      "Comment to go on in the same session.",
    ],
    [
      "usage_limit",
      "failed",
      "Failed: Claude Code's usage limit was reached on Aram's MacBook Pro.",
      "It starts again by itself once the limit resets.",
    ],
  ] as const)("%s: says why and what to do, always shown", (reason, state, line, todo) => {
    show(run(state, { reason }));
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.getByText(todo)).toBeInTheDocument();
  });

  it("names the program's title for Codex, and when a usage limit resets", () => {
    show(run("failed", { reason: "usage_limit", program: "codex", resets_at: now + 3_600_000 }));
    expect(screen.getByText("Failed: Codex's usage limit was reached on Aram's MacBook Pro.")).toBeInTheDocument();
    expect(screen.getByText(/^It starts again by itself at .+\.$/)).toBeInTheDocument();
  });

  it("says nothing for a reason it has no words for", () => {
    show(run("failed", { reason: "something_new" }));
    expect(screen.queryByText(/something_new/)).toBeNull();
  });

  it("says who stopped a stopped run", () => {
    show(run("stopped", { stop_requested_by: "u2", stop_requested_at: now - 90_000 }));
    expect(screen.getByText("Stopped by Bea.")).toBeInTheDocument();
  });
});

describe("Stop", () => {
  const stopButton = () => screen.queryByRole("button", { name: "Stop @claude's run on SVA-12" });

  it("asks an open run to stop, and says it is stopping until the run's state says so", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ results: [{}] });
    show(run("running"));
    fireEvent.click(stopButton() as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[1] as { changes: { type: string; args: unknown }[] };
    expect(body.changes.map(({ type, args }) => ({ type, args }))).toEqual([
      { type: "session.stop", args: { id: "s1" } },
    ]);
  });

  it("says Stopping… and cannot be pressed again while the stop is asked and the run is open", () => {
    show(run("waiting", { stop_requested_at: now - 1000, stop_requested_by: "u1" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("is not there on an ended run, on a session an agent recorded itself, or for someone who may not change the task", () => {
    show(run("done"));
    expect(stopButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();

    load();
    show(run("running", { machine_id: undefined }));
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("is not there for a member who may only read the task's project", () => {
    load({ ...bea, scope: { read_only: true } });
    show(run("running"));
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
});

describe("Continue in a terminal", () => {
  const command = () => screen.queryByText(/&& (claude --resume|codex resume) /);

  it("gives the agent's responsible person the line for the newest ended run, for each program", () => {
    show(run("done"), { newestRun: true });
    expand();
    expect(screen.getByText("Continue in a terminal on Aram's MacBook Pro:")).toBeInTheDocument();
    expect(command()?.textContent).toBe(`cd ~/'devel/game' && claude --resume ${id}`);
    expect(screen.getByRole("button", { name: /^Copy/ })).toBeInTheDocument();
    expect(screen.getByText(/^Quadit waits until the session has been quiet for 5 minutes/)).toBeInTheDocument();

    load();
    show(run("failed", { program: "codex", reason: "program_error" }), { newestRun: true });
    expand();
    expect(command()?.textContent).toBe(`cd ~/'devel/game' && codex resume ${id}`);
  });

  it("is not there on an open run, on an older run, or for someone else", () => {
    show(run("running"), { newestRun: true });
    expand();
    expect(command()).toBeNull();

    load();
    show(run("done"));
    expand();
    expect(command()).toBeNull();

    load(bea);
    show(run("done"), { newestRun: true });
    expand();
    expect(command()).toBeNull();
  });

  it("is not there when the session id or the folder is not of its form", () => {
    show(run("done", { program_session: "not-a-uuid" }), { newestRun: true });
    expand();
    expect(command()).toBeNull();
    expect(screen.queryByText(/Continue in a terminal/)).toBeNull();
  });
});

describe("the task's sessions", () => {
  const question = (over: Partial<Decision> = {}): Decision => ({
    id: "d1",
    task_id: "t1",
    kind: "choice",
    question: "Bye or ciao?",
    state: "open",
    rank: "a",
    created_by: "a1",
    created_at: now - 30_000,
    updated_at: now - 30_000,
    updated_seq: 3,
    ...over,
  });
  const older = run("done", { id: "s0", title: "First go", started_at: now - 60 * 60_000 });

  function tasks(sessions: AgentSession[], decisions: Decision[] = []) {
    load(ann, { sessions, decisions });
    wrap(<TaskWork task={task} />);
    return screen.getAllByRole("listitem").map((li) => li.textContent);
  }

  it("shows the newest run done as waiting for the answer to the question its agent asked, linking to it", () => {
    tasks([older, run("done")], [question()]);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Waiting for an answer")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "@claude asked: “Bye or ciao?”" })).toHaveAttribute(
      "href",
      "/acme/task/SVA-12",
    );
    expect(within(rows[1] as HTMLElement).getByText("Done")).toBeInTheDocument();
  });

  it("keeps waiting for an answer on the newest run Quadit started, whatever session the agent recorded itself after", () => {
    const manual = run("done", { id: "m1", title: "Notes", started_at: now, machine_id: undefined });
    tasks([run("done"), manual], [question()]);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Done")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Waiting for an answer")).toBeInTheDocument();
  });

  it("shows it done once the question is answered, or when it is someone else's", () => {
    tasks([run("done")], [question({ state: "picked" })]);
    expect(screen.queryByText("Waiting for an answer")).toBeNull();
    tasks([run("done")], [question({ created_by: "u2" })]);
    expect(screen.queryByText("Waiting for an answer")).toBeNull();
  });

  it("puts the open run first, above newer ended ones", () => {
    const rows = tasks([
      run("running", { id: "s2", title: "Working now", started_at: now - 10 * 60_000 }),
      run("done", { id: "s3", title: "Ended later", started_at: now - 2 * 60_000 }),
    ]);
    expect(rows[0]).toContain("Working now");
    expect(rows[1]).toContain("Ended later");
  });
});

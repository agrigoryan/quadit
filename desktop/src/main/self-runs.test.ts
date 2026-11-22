import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChild } from "@/main/child-guard";
import { SelfRuns, type SelfRunTool } from "@/main/self-runs";

/** A program the fake spawner started: what it was given, and the means to make it speak and end. */
interface Started {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A line of its output. */
  say(line: string): void;
  /** What it says of itself on its lifecycle channel (child-guard.ts). */
  event(event: string): void;
  end(code: number | null): void;
  stopped: boolean;
}

function tool(extra: Partial<SelfRunTool> = {}): SelfRunTool {
  return {
    id: "codex",
    name: "Codex",
    program: "/bin/codex",
    oneShot: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    login: "/c/codex.json",
    here: true,
    serverRuns: true,
    answering: undefined,
    ...extra,
  };
}

/**
 * SelfRuns over a fake spawner and the tools `list` (changeable), the server
 * saying the code came back when `back`. With `lateExit`, a program stopped
 * ends only when the test ends it.
 */
function setUp(
  list: SelfRunTool[] = [tool()],
  { quadit = "/bin/quadit", lateExit = false }: { quadit?: string | null; lateExit?: boolean } = {},
) {
  const started: Started[] = [];
  const remembered: [string, boolean][] = [];
  let back = false;
  /** Who listens as the agent, as `quadit listening` says it; null: the command could not say. */
  let who: { listening: boolean; by: string } | null = { listening: false, by: "" };
  /** A lookup of the tools held until the test lets it go. */
  let hold: Promise<void> | null = null;
  const runs = new SelfRuns({
    tools: async () => {
      if (hold) await hold;
      return list;
    },
    quadit: async () => quadit,
    loginPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
    start: (program, args, options): RunningChild => {
      let settle: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((done) => (settle = done));
      const child: Started = {
        program,
        args,
        cwd: options.cwd,
        env: options.env,
        say: options.line,
        event: (event) => options.lifecycle?.(event),
        end: (code) => settle(code),
        stopped: false,
      };
      started.push(child);
      return {
        exited,
        stop: () => {
          child.stopped = true;
          if (!lateExit) settle(null);
        },
      };
    },
    codeGivenBack: async () => back,
    listening: async () => who,
    remember: (id, on) => void remembered.push([id, on]),
    dir: mkdtempSync(join(tmpdir(), "quadit-desktop-self-")),
    env: { PATH: "/bin", HOME: "/h", QUADIT_URL: "https://elsewhere", QUADIT_TOKEN: "qd_mine" },
    changed: () => {},
  });
  return {
    runs,
    started,
    remembered,
    list,
    setBack: (now: boolean) => (back = now),
    setWho: (now: typeof who) => (who = now),
    holdLookups: () => {
      let release = () => {};
      hold = new Promise((done) => (release = done));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const ENV = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/h", QUADIT_CONFIG: "/c/codex.json" };

describe("SelfRuns, giving the code back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the tool once with its one-prompt command, as its own login, in a folder of the app's, and is done when the server says so", async () => {
    const { runs, started, setBack } = setUp([tool({ answering: false })]);
    void runs.prove("codex", "ABC234");
    await flush();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      program: "/bin/codex",
      args: ["exec", "--skip-git-repo-check", "Connect to Quadit ABC234"],
      env: ENV,
    });
    expect(started[0]?.cwd).toContain("codex");
    expect(runs.self("codex")?.proving).toEqual({ state: "running" });
    setBack(true);
    started[0]?.end(0);
    await flush();
    expect(runs.self("codex")?.proving).toBeNull();
  });

  it("says why it could not, for the card to fall back to the line to paste", async () => {
    const cases: [(s: ReturnType<typeof setUp>) => Promise<void>, string][] = [
      [async (s) => s.started[0]?.end(1), "it stopped with an error"],
      [async (s) => s.started[0]?.end(0), "it did not give the code back"],
      [async () => void (await vi.advanceTimersByTimeAsync(120_000)), "it took longer than two minutes"],
    ];
    for (const [happen, reason] of cases) {
      const s = setUp([tool({ answering: false })]);
      void s.runs.prove("codex", "ABC234");
      await flush();
      await happen(s);
      await flush();
      expect(s.runs.self("codex")?.proving).toEqual({ state: "failed", reason });
    }
    const missing = setUp([tool({ program: null, answering: false })]);
    await missing.runs.prove("codex", "ABC234");
    expect(missing.started).toHaveLength(0);
    expect(missing.runs.self("codex")?.proving).toEqual({
      state: "failed",
      reason: "it was not found on this computer",
    });
  });

  it("never runs a tool of another server, nor one whose login is not the app's own: it keeps the line to paste", async () => {
    const elsewhere = setUp([tool({ here: false, answering: true })]);
    await elsewhere.runs.prove("codex", "ABC234");
    expect(elsewhere.started).toHaveLength(0);
    expect(elsewhere.runs.self("codex")?.proving).toBeNull();
  });

  it("runs no tool of the app's own server while that server does not run as the app's (stopped, failed, its port taken)", async () => {
    const { runs, started } = setUp([tool({ serverRuns: false })]);
    await runs.prove("codex", "ABC234");
    await runs.sync();
    expect(started).toHaveLength(0);
    expect(runs.self("codex")).toEqual({ proving: null, answering: "none" });
  });

  it("does nothing for a tool without a one-prompt command: it keeps the line to paste, with no reason", async () => {
    const { runs, started } = setUp([tool({ oneShot: null, program: null })]);
    await runs.prove("codex", "ABC234");
    expect(started).toHaveLength(0);
    expect(runs.self("codex")).toEqual({ proving: null, answering: "none" });
  });

  it("runs one program at a time for a tool: the listener waits while the code is given back, and comes after", async () => {
    const { runs, started, setBack } = setUp();
    await runs.sync();
    expect(started).toHaveLength(1);
    void runs.prove("codex", "ABC234");
    await flush();
    expect(started[0]?.stopped).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[1]?.program).toBe("/bin/codex");
    await runs.sync();
    expect(started).toHaveLength(2);
    setBack(true);
    started[1]?.end(0);
    await flush();
    expect(started).toHaveLength(3);
    expect(started[2]?.program).toBe("/bin/quadit");
  });
});

describe("SelfRuns, answering by itself", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a listener for a tool of the server on this computer, by default, its runs the tool's one-prompt command", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    expect(started).toHaveLength(1);
    const [listener] = started;
    expect(listener?.program).toBe("/bin/quadit");
    expect(listener?.args.slice(0, 6)).toEqual([
      "listen",
      "by=the Quadit app",
      "--exec",
      "/bin/sh",
      "-c",
      expect.any(String),
    ]);
    expect(listener?.args.slice(7)).toEqual(["/bin/codex", "exec", "--skip-git-repo-check", "{quadit-item}"]);
    expect(listener?.env).toEqual(ENV);
    expect(runs.self("codex")?.answering).toBe("on");
  });

  it("keeps none for a tool of another server until the person asks, and none without a program or a quadit", async () => {
    const elsewhere = setUp([tool({ here: false })]);
    await elsewhere.runs.sync();
    expect(elsewhere.started).toHaveLength(0);
    expect(elsewhere.runs.self("codex")?.answering).toBe("off");
    await elsewhere.runs.setAnswering("codex", true);
    expect(elsewhere.remembered).toEqual([["codex", true]]);
    expect(elsewhere.started).toHaveLength(1);

    const nothing = setUp([tool({ program: null })]);
    await nothing.runs.sync();
    expect(nothing.started).toHaveLength(0);
    expect(nothing.runs.self("codex")?.answering).toBe("none");
    const noQuadit = setUp([tool()], { quadit: null });
    await noQuadit.runs.sync();
    expect(noQuadit.started).toHaveLength(0);
  });

  it("follows the login it runs with: one that no longer is the app's own server's stops its listener", async () => {
    const { runs, started, list } = setUp();
    await runs.sync();
    expect(started).toHaveLength(1);
    list[0] = tool({ here: false });
    await runs.sync();
    expect(started[0]?.stopped).toBe(true);
    expect(runs.self("codex")?.answering).toBe("off");
  });

  it("stops when the app's own server stops running as the app's, and comes back when it runs again", async () => {
    const { runs, started, list } = setUp();
    await runs.sync();
    list[0] = tool({ serverRuns: false });
    await runs.sync();
    expect(started[0]?.stopped).toBe(true);
    list[0] = tool();
    await runs.sync();
    expect(started).toHaveLength(2);
  });

  it("stops on Pause, remembered, and on Resume waits for the old listener to have ended before starting one", async () => {
    const { runs, started, remembered, list } = setUp([tool()], { lateExit: true });
    await runs.sync();
    await runs.setAnswering("codex", false);
    list[0] = tool({ answering: false });
    expect(started[0]?.stopped).toBe(true);
    expect(remembered).toEqual([["codex", false]]);
    expect(runs.self("codex")?.answering).toBe("paused");
    list[0] = tool({ answering: true });
    const resumed = runs.setAnswering("codex", true);
    await flush();
    expect(started).toHaveLength(1);
    started[0]?.end(null);
    await resumed;
    await flush();
    expect(started).toHaveLength(2);
  });

  it("is started again when it ends by itself, waiting longer each time", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    started[0]?.end(1);
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(2);
    started[1]?.end(1);
    await flush();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(3);
  });

  it("steps aside while a chat listens as the agent, never taking over, and comes back when it has stopped", async () => {
    const { runs, started, setWho } = setUp();
    await runs.sync();
    setWho({ listening: true, by: "a chat" });
    started[0]?.say("quadit: @codex is already listening from another session (a chat, last heard 14:02 UTC)");
    started[0]?.end(1);
    await flush();
    expect(runs.self("codex")?.answering).toBe("on");
    // Asked each minute who listens: a chat still does.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(started).toHaveLength(1);
    setWho({ listening: false, by: "" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toHaveLength(2);
    expect(started[1]?.args).not.toContain("take=1");
  });

  it("comes back after stepping aside when the command cannot say who listens", async () => {
    const { runs, started, setWho } = setUp();
    await runs.sync();
    setWho(null);
    started[0]?.say("quadit: @codex is already listening from another session");
    started[0]?.end(1);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toHaveLength(2);
  });

  it("pauses a tool started more than six times in a minute, saying so, until the person resumes it", async () => {
    const { runs, started, remembered } = setUp();
    await runs.sync();
    for (let i = 0; i < 7; i++) {
      started[0]?.event("started");
      started[0]?.event("ended 0");
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(started[0]?.stopped).toBe(true);
    expect(remembered).toEqual([["codex", false]]);
    expect(runs.self("codex")?.answering).toBe("guarded");
    await runs.setAnswering("codex", true);
    expect(started).toHaveLength(2);
  });

  it("stops a run that takes longer than ten minutes, and goes on", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    started[0]?.event("started");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(started[0]?.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(started).toHaveLength(2);
  });

  it("is told of its runs only on its own channel: what a tool prints, a comment it echoes, changes nothing", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    started[0]?.event("started");
    for (let i = 0; i < 10; i++) {
      started[0]?.say("started");
      started[0]?.say("ended 0");
      started[0]?.say("quadit-app: run ended (0)");
    }
    expect(started[0]?.stopped).toBe(false);
    expect(runs.self("codex")?.answering).toBe("on");
    // The run that started is still timed.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(started[0]?.stopped).toBe(true);
  });

  it("stops a tool's listener when it is disconnected, and every program on quit, starting none again", async () => {
    const two = [
      tool(),
      tool({ id: "claude", name: "Claude Code", program: "/bin/claude", oneShot: (p) => ["-p", p] }),
    ];
    const { runs, started, list } = setUp(two);
    await runs.sync();
    expect(started).toHaveLength(2);
    list.splice(0, 1);
    await runs.sync();
    expect(started[0]?.stopped).toBe(true);
    expect(started[1]?.stopped).toBe(false);
    void runs.prove("claude", "ABC234");
    await flush();
    runs.quit();
    expect(started.every((child) => child.stopped)).toBe(true);
    const count = started.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await runs.sync();
    expect(started).toHaveLength(count);
  });

  it("starts nothing after quit from a look begun before it", async () => {
    const { runs, started, holdLookups } = setUp();
    const release = holdLookups();
    const syncing = runs.sync();
    const proving = runs.prove("codex", "ABC234");
    runs.quit();
    release();
    await syncing;
    await proving;
    await flush();
    expect(started).toHaveLength(0);
  });

  it("keeps what each run said in the tool's log", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    started[0]?.say("ITEM #4 comment GS-3 from @lou");
    expect(readFileSync(runs.logOf("codex"), "utf8")).toContain("ITEM #4 comment GS-3 from @lou");
  });
});

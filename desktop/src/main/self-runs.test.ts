import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
    ran: true,
    ...extra,
  };
}

/** SelfRuns over a fake spawner and the tools `list` (changeable), the server saying the code came back when `back`. */
function setUp(list: SelfRunTool[] = [tool()]) {
  const started: Started[] = [];
  const ran: string[] = [];
  const codesAsked: string[] = [];
  const open = new Map<string, string>();
  let back = false;
  /** A lookup of the tools held until the test lets it go. */
  let hold: Promise<void> | null = null;
  const dir = mkdtempSync(join(tmpdir(), "quadit-desktop-self-"));
  const runs = new SelfRuns({
    look: async () => {
      if (hold) await hold;
      return { tools: list, path: "/opt/homebrew/bin:/usr/bin:/bin" };
    },
    start: (program, args, options): RunningChild => {
      let settle: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((done) => (settle = done));
      const child: Started = {
        program,
        args,
        cwd: options.cwd,
        env: options.env,
        say: options.line,
        end: (code) => settle(code),
        stopped: false,
      };
      started.push(child);
      return {
        exited,
        stop: () => {
          child.stopped = true;
          settle(null);
        },
      };
    },
    codeGivenBack: async () => back,
    openCode: (id) => open.get(id) ?? null,
    newCode: async (id) => void codesAsked.push(id),
    ran: (id) => void ran.push(id),
    dir,
    env: { PATH: "/bin", HOME: "/h", QUADIT_URL: "https://elsewhere", QUADIT_TOKEN: "qd_mine" },
    changed: () => {},
  });
  return {
    runs,
    started,
    ran,
    codesAsked,
    open,
    list,
    setBack: (now: boolean) => (back = now),
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
    const { runs, started, setBack, ran } = setUp([tool({ ran: false })]);
    void runs.prove("codex", "ABC234");
    await flush();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      program: "/bin/codex",
      args: ["exec", "--skip-git-repo-check", "Connect to Quadit ABC234"],
      env: ENV,
    });
    expect(started[0]?.cwd).toContain("codex");
    expect(runs.self("codex")).toEqual({ proving: { state: "running" } });
    setBack(true);
    started[0]?.end(0);
    await flush();
    expect(runs.self("codex")).toEqual({ proving: null });
    expect(ran).toEqual(["codex"]);
  });

  it("says it is giving the code back at once, before it has looked at the tools", async () => {
    const { runs, holdLookups } = setUp([tool({ ran: false })]);
    const release = holdLookups();
    void runs.prove("codex", "ABC234");
    expect(runs.self("codex")?.proving).toEqual({ state: "running" });
    release();
    await flush();
  });

  it("says why it could not, for the card to fall back to the line to paste", async () => {
    const cases: [(s: ReturnType<typeof setUp>) => Promise<void>, string][] = [
      [async (s) => s.started[0]?.end(1), "it stopped with an error"],
      [async (s) => s.started[0]?.end(0), "it did not give the code back"],
      [async (s) => s.started[0]?.end(127), "it was not found on this computer"],
      [async (s) => s.started[0]?.end(126), "it cannot be started from where it is installed"],
      [async () => void (await vi.advanceTimersByTimeAsync(120_000)), "it took longer than two minutes"],
    ];
    for (const [happen, reason] of cases) {
      const s = setUp([tool({ ran: false })]);
      void s.runs.prove("codex", "ABC234");
      await flush();
      await happen(s);
      await flush();
      expect(s.runs.self("codex")?.proving).toEqual({ state: "failed", reason });
      expect(s.ran).toEqual([]);
    }
    const missing = setUp([tool({ program: null, ran: false })]);
    await missing.runs.prove("codex", "ABC234");
    expect(missing.started).toHaveLength(0);
    expect(missing.runs.self("codex")?.proving).toEqual({
      state: "failed",
      reason: "it was not found on this computer",
    });
  });

  it("never runs a tool of another server, nor one whose login is not the app's own: it keeps the line to paste", async () => {
    const elsewhere = setUp([tool({ here: false, ran: false })]);
    await elsewhere.runs.prove("codex", "ABC234");
    await elsewhere.runs.sync();
    expect(elsewhere.started).toHaveLength(0);
    expect(elsewhere.codesAsked).toEqual([]);
    expect(elsewhere.runs.self("codex")).toEqual({ proving: null });
  });

  it("runs no tool of the app's own server while that server does not run as the app's (stopped, failed, its port taken)", async () => {
    const { runs, started } = setUp([tool({ serverRuns: false, ran: false })]);
    await runs.prove("codex", "ABC234");
    await runs.sync();
    expect(started).toHaveLength(0);
    expect(runs.self("codex")).toEqual({ proving: null });
  });

  it("stops a run giving the code back when the app's own server stops running as the app's", async () => {
    const { runs, started, list } = setUp([tool({ ran: false })]);
    void runs.prove("codex", "ABC234");
    await flush();
    list[0] = tool({ ran: false, serverRuns: false });
    await runs.sync();
    expect(started[0]?.stopped).toBe(true);
  });

  it("does nothing for a tool without a one-prompt command: it keeps the line to paste, with no reason", async () => {
    const { runs, started } = setUp([tool({ oneShot: null, program: null })]);
    await runs.prove("codex", "ABC234");
    expect(started).toHaveLength(0);
    expect(runs.self("codex")).toEqual({ proving: null });
  });

  it("stops the run giving the code back when the tool is taken back (Undo), and starts none from a look begun before", async () => {
    const running = setUp([tool({ ran: false })]);
    void running.runs.prove("codex", "ABC234");
    await flush();
    expect(running.started).toHaveLength(1);
    running.list.splice(0, 1);
    running.runs.disconnected("codex");
    expect(running.started[0]?.stopped).toBe(true);
    await flush();
    expect(running.runs.self("codex")).toBeNull();

    const looking = setUp([tool({ ran: false })]);
    const release = looking.holdLookups();
    const proving = looking.runs.prove("codex", "ABC234");
    looking.runs.disconnected("codex");
    release();
    await proving;
    await flush();
    expect(looking.started).toHaveLength(0);
  });
});

describe("SelfRuns, a look at the tools", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives the code back for a tool the app never ran: the open one, else a new one, asked once", async () => {
    const withCode = setUp([tool({ ran: false })]);
    withCode.open.set("codex", "ABC234");
    await withCode.runs.sync();
    await flush();
    expect(withCode.started.map((c) => c.program)).toEqual(["/bin/codex"]);
    expect(withCode.started[0]?.args.at(-1)).toBe("Connect to Quadit ABC234");

    const without = setUp([tool({ ran: false })]);
    await without.runs.sync();
    await without.runs.sync();
    expect(without.started).toHaveLength(0);
    expect(without.codesAsked).toEqual(["codex"]);
  });

  it("starts nothing else, ever: no listener for a tool it ran, before or after its code came back", async () => {
    const { runs, started, setBack, list } = setUp([tool({ ran: false })]);
    list.push(tool({ id: "claude", name: "Claude Code", program: "/bin/claude", login: "/c/claude.json" }));
    void runs.prove("codex", "ABC234");
    await flush();
    setBack(true);
    started[0]?.end(0);
    await flush();
    await runs.sync();
    await vi.advanceTimersByTimeAsync(600_000);
    await runs.sync();
    expect(started.map((c) => c.program)).toEqual(["/bin/codex"]);
    expect(runs.self("claude")).toEqual({ proving: null });
  });

  it("stops every run on quit, and starts none after it, from a look begun before either", async () => {
    const { runs, started } = setUp([tool({ ran: false })]);
    void runs.prove("codex", "ABC234");
    await flush();
    runs.quit();
    expect(started[0]?.stopped).toBe(true);

    const later = setUp([tool({ ran: false })]);
    later.open.set("codex", "ABC234");
    const release = later.holdLookups();
    const syncing = later.runs.sync();
    const proving = later.runs.prove("codex", "ABC234");
    later.runs.quit();
    release();
    await syncing;
    await proving;
    await flush();
    expect(later.started).toHaveLength(0);
  });

  it("keeps what each run said in the tool's log, for the person's eyes only", async () => {
    const { runs, started } = setUp([tool({ ran: false })]);
    void runs.prove("codex", "ABC234");
    await flush();
    started[0]?.say("Connected as @codex");
    expect(readFileSync(runs.logOf("codex"), "utf8")).toContain("Connected as @codex");
    // Windows keeps no such modes.
    if (process.platform !== "win32") expect(statSync(runs.logOf("codex")).mode & 0o777).toBe(0o600);
  });
});

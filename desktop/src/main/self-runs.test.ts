import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_FILE, type RunningChild } from "@/main/child-guard";
import { SelfRuns, type SelfRunTool, WAKE_SCRIPT } from "@/main/self-runs";

/** A program the fake spawner started: what it was given, and the means to make it speak and end. */
interface Started {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A line of its output. */
  say(line: string): void;
  /** A line of its report (`quadit listen events=`). */
  report(event: Record<string, unknown>): void;
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
    answering: true,
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
      return { tools: list, quadit, path: "/opt/homebrew/bin:/usr/bin:/bin" };
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
        report: (event) => options.events?.(JSON.stringify(event)),
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
    openCode: (id) => open.get(id) ?? null,
    newCode: async (id) => void codesAsked.push(id),
    ran: (id) => void ran.push(id),
    remember: (id, on) => void remembered.push([id, on]),
    dir,
    env: { PATH: "/bin", HOME: "/h", QUADIT_URL: "https://elsewhere", QUADIT_TOKEN: "qd_mine" },
    changed: () => {},
  });
  return {
    runs,
    started,
    remembered,
    ran,
    codesAsked,
    open,
    list,
    dir,
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
const STARTED = { event: "started", as: "@codex", by: "the Quadit app", cursor: "listen" };

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
    expect(runs.self("codex")?.proving).toEqual({ state: "running" });
    setBack(true);
    started[0]?.end(0);
    await flush();
    expect(runs.self("codex")?.proving).toBeNull();
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
    expect(elsewhere.runs.self("codex")).toEqual({ proving: null, answering: "none" });
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

describe("SelfRuns, proof before listening", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("listens for a tool the app never ran only once it has given a code back: the open one, else a new one, asked once", async () => {
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

  it("starts no listener for a tool whose run failed: its card keeps the line to paste, saying nothing of answering", async () => {
    const { runs, started, open } = setUp([tool({ ran: false })]);
    open.set("codex", "ABC234");
    await runs.sync();
    await flush();
    started[0]?.end(1);
    await flush();
    await runs.sync();
    expect(started).toHaveLength(1);
    expect(runs.self("codex")).toEqual({
      proving: { state: "failed", reason: "it stopped with an error" },
      answering: "none",
    });
  });
});

describe("SelfRuns, answering by itself", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a listener for a tool of the server on this computer, by default, bounded and reported by quadit listen", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    expect(started).toHaveLength(1);
    const [listener] = started;
    expect(listener?.program).toBe("/bin/quadit");
    expect(listener?.args.slice(0, 9)).toEqual([
      "listen",
      "by=the Quadit app",
      "limit=600",
      "tries=3",
      `events=${EVENTS_FILE}`,
      "--exec",
      "/bin/sh",
      "-c",
      WAKE_SCRIPT,
    ]);
    expect(listener?.args.slice(9)).toEqual([
      "quadit-wake",
      "/bin/codex",
      "exec",
      "--skip-git-repo-check",
      "{quadit-item}",
    ]);
    expect(listener?.env).toEqual(ENV);
    expect(runs.self("codex")?.answering).toBe("on");
  });

  it("keeps none for a tool of another server, offering none, and none without a program or a quadit", async () => {
    const elsewhere = setUp([tool({ here: false })]);
    await elsewhere.runs.sync();
    expect(elsewhere.started).toHaveLength(0);
    expect(elsewhere.runs.self("codex")?.answering).toBe("none");
    await elsewhere.runs.setAnswering("codex", true);
    expect(elsewhere.started).toHaveLength(0);

    const nothing = setUp([tool({ program: null })]);
    await nothing.runs.sync();
    expect(nothing.started).toHaveLength(0);
    expect(nothing.runs.self("codex")?.answering).toBe("none");
    const noQuadit = setUp([tool()], { quadit: null });
    await noQuadit.runs.sync();
    expect(noQuadit.started).toHaveLength(0);
  });

  it("keeps one listener for a login: the other tools on it say nothing of answering", async () => {
    const claude = tool({ id: "claude", name: "Claude Code", program: "/bin/claude", oneShot: (p) => ["-p", p] });
    const { runs, started, list } = setUp([tool(), claude]);
    await runs.sync();
    expect(started).toHaveLength(1);
    expect(runs.self("codex")?.answering).toBe("on");
    expect(runs.self("claude")?.answering).toBe("none");
    list[1] = { ...claude, login: "/c/claude.json" };
    await runs.sync();
    expect(started).toHaveLength(2);
    expect(runs.self("claude")?.answering).toBe("on");
  });

  it("follows the login it runs with: one that no longer is the app's own server's stops its listener", async () => {
    const { runs, started, list } = setUp();
    await runs.sync();
    expect(started).toHaveLength(1);
    list[0] = tool({ here: false });
    await runs.sync();
    expect(started[0]?.stopped).toBe(true);
    expect(runs.self("codex")?.answering).toBe("none");
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

  it("tries again within a minute when refused because a chat listens as the agent, never taking over", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    for (let n = 0; n < 8; n++) {
      const listener = started.at(-1);
      listener?.report({ event: "refused", why: "listening_elsewhere", by: "a chat", last_heard: "2026-11-21 14:02" });
      listener?.report({ event: "stopped", why: "refused" });
      listener?.end(1);
      await flush();
      expect(runs.self("codex")?.answering).toBe("on");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(started).toHaveLength(n + 2);
      expect(started.at(-1)?.args).not.toContain("take=1");
    }
  });

  it("pauses a tool started more than six times in a minute, saying so, until the person resumes it", async () => {
    const { runs, started, remembered } = setUp();
    await runs.sync();
    started[0]?.report(STARTED);
    for (let seq = 1; seq <= 6; seq++) {
      started[0]?.report({ event: "run_started", seq, try: 1 });
      started[0]?.report({ event: "run_ended", seq, seconds: 1, status: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(runs.self("codex")?.answering).toBe("on");
    started[0]?.report({ event: "run_started", seq: 7, try: 1 });
    expect(started[0]?.stopped).toBe(true);
    expect(remembered).toEqual([["codex", false]]);
    expect(runs.self("codex")?.answering).toBe("guarded");
    await runs.setAnswering("codex", true);
    expect(started).toHaveLength(2);
  });

  it("says an item it could not answer, why, until it answers the next", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    const listener = started[0];
    listener?.report(STARTED);
    for (let tries = 1; tries <= 3; tries++) {
      listener?.report({ event: "run_started", seq: 4, try: tries });
      listener?.report({ event: "run_ended", seq: 4, seconds: 600, status: "limit" });
    }
    listener?.report({ event: "gave_up", seq: 4, why: "3 failed runs" });
    expect(runs.self("codex")).toMatchObject({ answering: "on", missed: "it took too long" });
    listener?.report({ event: "run_started", seq: 5, try: 1 });
    listener?.report({ event: "run_ended", seq: 5, seconds: 3, status: 2 });
    listener?.report({ event: "gave_up", seq: 5, why: "3 failed runs" });
    expect(runs.self("codex")).toMatchObject({ missed: "Codex stopped with an error" });
    listener?.report({ event: "run_started", seq: 6, try: 1 });
    listener?.report({ event: "run_ended", seq: 6, seconds: 3, status: 0 });
    expect(runs.self("codex")?.missed).toBeUndefined();
  });

  it("stops a tool's listener when it is disconnected, and every program on quit, starting none again", async () => {
    const two = [
      tool(),
      tool({
        id: "claude",
        name: "Claude Code",
        program: "/bin/claude",
        oneShot: (p) => ["-p", p],
        login: "/c/cc.json",
      }),
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

  it("keeps what each run said in the tool's log, for the person's eyes only", async () => {
    const { runs, started } = setUp();
    await runs.sync();
    started[0]?.say("ITEM #4 comment GS-3 from @lou");
    expect(readFileSync(runs.logOf("codex"), "utf8")).toContain("ITEM #4 comment GS-3 from @lou");
    expect(statSync(runs.logOf("codex")).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(process.platform === "win32")("the wake command", () => {
  it("hands the tool the item's prompt as one argument, word for word, whatever the item says", () => {
    const item = [
      "ITEM #4 comment GS-3 from @lou (agent): \"it's $(touch /tmp/x) `id` $HOME \\ ; & | *",
      "  read: quadit show GS-3",
      "  answer: quadit comment GS-3 --id 7f -",
    ].join("\n");
    const out = execFileSync(
      "/bin/sh",
      ["-c", WAKE_SCRIPT, "quadit-wake", "/usr/bin/printf", "%s\\0", "a b", "{quadit-item}", "*"],
      { env: { PATH: "/usr/bin:/bin", QUADIT_ITEM: item, QUADIT_EVENT: "ignored" }, cwd: "/" },
    ).toString();
    expect(out.split("\0").slice(0, -1)).toEqual([
      "a b",
      `Quadit woke you for this inbox item:\n${item}\nHandle it with the quadit skill, answering where you were asked.`,
      "*",
    ]);
  });
});

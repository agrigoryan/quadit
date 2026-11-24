// The app's side of quadit run against a stand-in of its commands
// (test/fake-quadit-run.cjs), in a home folder of the test's own: the
// supervisor over a spawner that can be faked, and once over the real guard.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningChild, startChild } from "@/main/child-guard";
import { NOT_SERVED, Runner } from "@/main/runner";

const FAKE = join(__dirname, "../../test/fake-quadit-run.cjs");
const posixOnly = describe.skipIf(process.platform === "win32");

/** A quadit run the fake spawner started: what it was given, and the means to end it. */
interface Started {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  end(code: number | null): void;
  stopped: boolean;
}

/** Waits, in real time, until `check` holds. */
async function until(check: () => boolean, ms = 5_000) {
  for (const end = performance.now() + ms; performance.now() < end;) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error("it never held");
}

/**
 * A Runner over the stand-in quadit in a home of its own, with the agent's
 * login (@claude, who may work in the PROJECTS) and a folder there for each
 * project, and a claude and a codex on the login shell's PATH; `start` the
 * spawner, faked unless given; `env` added to the app's.
 */
function setUp({ start, env = {} }: { start?: typeof startChild; env?: Record<string, string> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-runner-")));
  const home = join(root, "home");
  const configDir =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "quadit")
      : join(home, ".config", "quadit");
  mkdirSync(configDir, { recursive: true });
  const quadit = join(root, "quadit");
  writeFileSync(quadit, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(quadit, 0o755);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const program of ["claude", "codex"]) {
    writeFileSync(join(bin, program), "#!/bin/sh\necho 2.1.331\n");
    chmodSync(join(bin, program), 0o755);
  }
  const me = (handle: string) => ({
    handle,
    kind: "agent",
    projects: PROJECTS,
    project_names: { SVA: "Samurai vs Aliens", GS: "Getting started" },
  });
  const login = join(configDir, "claude.json");
  writeFileSync(login, JSON.stringify({ url: "https://q.example", token: "qd_x", me: me("@claude") }));
  const otherLogin = join(configDir, "codex.json");
  writeFileSync(otherLogin, JSON.stringify({ url: "https://q.example", token: "qd_y", me: me("@codex") }));
  const game = join(home, "game");
  const site = join(home, "site");
  mkdirSync(game);
  mkdirSync(site);
  /** A folder of its own for a project. */
  const folderOf = (project: string) => {
    const folder = join(home, project.toLowerCase());
    mkdirSync(folder, { recursive: true });
    return folder;
  };
  const started: Started[] = [];
  const logged: string[] = [];
  const fakeStart: typeof startChild = (program, args, options): RunningChild => {
    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((done) => (settle = done));
    const child: Started = { program, args, env: options.env, end: (code) => settle(code), stopped: false };
    started.push(child);
    return {
      exited,
      stop: () => {
        child.stopped = true;
        settle(null);
      },
    };
  };
  const parts = {
    quadit: () => quadit,
    path: async () => `${bin}:/usr/bin:/bin`,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      QUADIT_URL: "https://elsewhere",
      QUADIT_TOKEN: "qd_mine",
      QUADIT_CONFIG: "/x.json",
      ...env,
    },
    start: start ?? fakeStart,
    log: (line: string) => void logged.push(line),
    changed: () => {},
  };
  return {
    runner: new Runner(parts),
    /** Another start of the app on the same computer. */
    again: () => new Runner(parts),
    started,
    logged,
    login,
    otherLogin,
    configDir,
    game,
    site,
    folderOf,
    bin,
    quadit,
  };
}

const PROJECTS = ["SVA", "GS", "ART", "WEB", "API", "DOC", "OPS", "LAB"];

/** An entry's status as a serving runner writes it: every field there. */
const said = (fields: Record<string, unknown>) => ({
  state: "",
  task: "",
  since: "",
  pause: "",
  until: "",
  message: "",
  blocked: [],
  ...fields,
});

/** Says, as a serving runner, what each entry does (runner/status.json), the lock held by this test. */
function serving(configDir: string, entries: Record<string, unknown>) {
  mkdirSync(join(configDir, "runner"), { recursive: true });
  writeFileSync(join(configDir, "runner", "runner.lock"), String(process.pid));
  writeFileSync(
    join(configDir, "runner", "status.json"),
    JSON.stringify({ version: 1, pid: process.pid, at: "2026-11-24T14:05:00Z", machine: {}, entries }),
  );
}

posixOnly("Runner, supervising quadit run", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("starts it at the app's start only when the registry has an entry, and after an add, with the login shell's PATH and no QUADIT_ setting", async () => {
    const { runner, again, started, login, game, site, quadit, bin } = setUp();
    await runner.sync();
    expect(started).toHaveLength(0);
    expect(await runner.add({ login, project: "SVA", folder: game, program: "claude" })).toEqual({ ok: true });
    expect(started).toHaveLength(1);
    expect(started[0]?.program).toBe(quadit);
    expect(started[0]?.args).toEqual(["run"]);
    expect(started[0]?.env.PATH).toBe(`${bin}:/usr/bin:/bin`);
    expect(Object.keys(started[0]?.env ?? {}).filter((key) => key.startsWith("QUADIT_"))).toEqual([]);
    // Another add while it runs starts no second one.
    await runner.add({ login, project: "GS", folder: site, program: "claude" });
    expect(started).toHaveLength(1);

    const next = again();
    await next.sync();
    expect(started).toHaveLength(2);
  });

  it("starts it again when it ends by itself, waiting longer each time, and from the first wait once it ran a minute", async () => {
    const { runner, started, login, game, logged } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    started[0]?.end(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => started.length === 2);
    expect(logged).toContain("quadit run ended (exit 1); starting it again in 2 s");

    started[1]?.end(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => started.length === 3);

    await vi.advanceTimersByTimeAsync(60_000);
    started[2]?.end(null);
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => started.length === 4);
  });

  it("does not start it again when another quadit run serves this computer: its entries say so, and it tries again every 5 minutes", async () => {
    const { runner, started, login, game } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    started[0]?.end(3);
    await vi.advanceTimersByTimeAsync(0);
    expect((await runner.entries(login))?.[0]?.status).toEqual({ state: "not_served", message: NOT_SERVED.another });
    expect(NOT_SERVED.another).toBe("Another quadit run serves this computer.");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => started.length === 2);
  });

  it("starts it again at once after a remove, which held the runner's lock while it worked", async () => {
    const { runner, started, login, game, site } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    await runner.add({ login, project: "GS", folder: site, program: "claude" });
    started[0]?.end(3);
    await vi.advanceTimersByTimeAsync(0);
    const [first] = (await runner.entries(login)) ?? [];
    expect(await runner.remove({ entry: first?.id ?? "" })).toEqual({ ok: true });
    expect(started).toHaveLength(2);
  });

  it("reads the list again when it cannot at a start, waiting longer each time, and the card is told it cannot", async () => {
    const { runner, started, login, game, configDir, logged } = setUp();
    const registry = join(configDir, "runner.json");
    writeFileSync(registry, "{ not json");
    await runner.sync();
    expect(started).toHaveLength(0);
    expect(await runner.entries(login)).toBeNull();
    const failed = () => logged.filter((line) => line.startsWith("quadit run list:")).length;
    const before = failed();
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => failed() > before);
    const entry = { id: "e5d2a91c", login, project: "SVA", folder: game, program: "claude", removing: false };
    writeFileSync(registry, JSON.stringify({ version: 1, machine: { id: "m", name: "Test Mac" }, entries: [entry] }));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => started.length === 1);
    runner.quit();
  });

  it("stops it once a removal that gave up waiting is done after all, looking at the registry again", async () => {
    const { runner, started, login, game, configDir } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    serving(configDir, {});
    expect(await runner.remove({ login })).toMatchObject({ ok: false, pending: true });
    expect(started[0]?.stopped).toBe(false);
    // The runner lets the entry go once the server has heard.
    writeFileSync(
      join(configDir, "runner.json"),
      JSON.stringify({ version: 1, machine: { id: "m", name: "Test Mac" }, entries: [] }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => started[0]?.stopped === true);
  });

  it("stops it at quit, never waiting for it, and starts nothing after", async () => {
    const { runner, started, login, game } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    runner.quit();
    expect(started[0]?.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runner.sync();
    expect(started).toHaveLength(1);
  });

  it("stops it when the last entry goes, and only then", async () => {
    const { runner, started, login, otherLogin, game, site } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    await runner.add({ login: otherLogin, project: "GS", folder: site, program: "codex" });
    const [entry] = (await runner.entries(login)) ?? [];
    expect(await runner.remove({ entry: entry?.id ?? "" })).toEqual({ ok: true });
    expect(started[0]?.stopped).toBe(false);
    expect(await runner.remove({ login: otherLogin })).toEqual({ ok: true });
    expect(started[0]?.stopped).toBe(true);
    // Stopped by the app: not started again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(started).toHaveLength(1);
  });
});

posixOnly("Runner, its commands", () => {
  it("passes the refusals of quadit run add through as they were said, and starts nothing for them", async () => {
    const { runner, started, login, game, site } = setUp();
    expect(await runner.add({ login, project: "SVA", folder: "game", program: "claude" })).toEqual({
      ok: false,
      error: "folder= must be an absolute path",
    });
    expect(await runner.add({ login, project: "SVA", folder: join(game, "gone"), program: "claude" })).toEqual({
      ok: false,
      error: "~/game/gone does not exist",
    });
    expect(await runner.add({ login, project: "XYZ", folder: game, program: "claude" })).toEqual({
      ok: false,
      error: `@claude may not work in XYZ: quadit me lists its projects (it may work in ${PROJECTS.join(", ")})`,
    });
    expect(started).toHaveLength(0);
    expect(await runner.add({ login, project: "sva", folder: game, program: "claude" })).toEqual({ ok: true });
    expect(await runner.add({ login, project: "SVA", folder: site, program: "claude" })).toEqual({
      ok: false,
      error: "@claude already runs SVA on this computer, in ~/game",
    });
    expect(await runner.add({ login, project: "GS", folder: game, program: "claude" })).toEqual({
      ok: false,
      error: "~/game already runs SVA on this computer: one project per folder",
    });
  });

  it("passes on that a program is not found, as quadit run add says it", async () => {
    const { runner, login, game } = setUp();
    expect(
      await runner.add({ login, project: "SVA", folder: game, program: "claude", programPath: "/nowhere/claude" }),
    ).toEqual({ ok: false, error: "Claude Code was not found on this computer: install it, or give program_path=" });
  });

  it("says what each entry of the tool's login does, as a serving runner's status says it", async () => {
    const { runner, login, otherLogin, site, configDir, folderOf } = setUp();
    for (const project of PROJECTS) await runner.add({ login, project, folder: folderOf(project), program: "claude" });
    await runner.add({ login: otherLogin, project: "SVA", folder: site, program: "codex" });
    const ids = ((await runner.entries(login)) ?? []).map((e) => e.id);
    expect(ids).toHaveLength(8);
    const [ready = "", working = "", paused = "", aside = "", failed = "", removing = "", unsaid = ""] = ids;
    serving(configDir, {
      [ready]: said({ state: "ready", blocked: [{ run: "r1", task: "SVA-11", write: "end", error: "forbidden: no" }] }),
      [working]: said({ state: "working", task: "GS-3", since: "2026-11-24T14:02:10Z" }),
      [paused]: said({ state: "paused", pause: "usage_limit", until: "2026-11-24T18:00:00Z" }),
      [aside]: said({ state: "aside" }),
      [failed]: said({ state: "error", message: "login refused" }),
      [removing]: said({ state: "removing" }),
      [unsaid]: said({}),
    });
    const entries = (await runner.entries(login)) ?? [];
    expect(entries.map((e) => e.status)).toEqual([
      { state: "ready" },
      { state: "working", task: "GS-3" },
      { state: "paused", pause: "usage_limit", until: "2026-11-24T18:00:00Z" },
      { state: "aside" },
      { state: "error", message: "login refused" },
      { state: "removing" },
      { state: "starting" },
      { state: "starting" },
    ]);
    expect(entries[0]).toEqual({
      id: ready,
      project: "SVA",
      folder: "~/sva",
      program: "claude",
      status: { state: "ready" },
      blocked: [{ task: "SVA-11", error: "forbidden: no" }],
    });
  });

  it("says an entry no runner serves is not running, and one starting while its runner starts", async () => {
    const { runner, login, game } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    // The fake spawner's runner serves nothing: the list says none serves.
    expect((await runner.entries(login))?.[0]?.status).toEqual({ state: "starting" });
    runner.quit();
    expect((await runner.entries(login))?.[0]?.status).toEqual({ state: "not_served", message: "Not running." });
  });

  it("removes an entry, and says what remove said when the runner could not finish in time", async () => {
    const { runner, login, game, configDir } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    // A runner serves that never drops the entry: remove gives up.
    serving(configDir, {});
    expect(await runner.remove({ login })).toEqual({
      ok: false,
      error: "Quadit is still telling the server how @claude's last run ended; it is removed once the server answers.",
      pending: true,
    });
    expect((await runner.entries(login))?.[0]?.status).toEqual({ state: "removing" });
    writeFileSync(join(configDir, "runner", "runner.lock"), "");
    expect(await runner.remove({ login })).toEqual({ ok: true });
    expect(await runner.entries(login)).toEqual([]);
    runner.quit();
  });

  it("removes a login's entries matched by its real path, and keeps what quadit run said when it could not", async () => {
    const { runner, login, game, configDir } = setUp();
    const linked = join(configDir, "linked.json");
    symlinkSync(login, linked);
    await runner.add({ login: linked, project: "SVA", folder: game, program: "claude" });
    expect((await runner.entries(login))?.map((e) => e.project)).toEqual(["SVA"]);
    // A registry that cannot be written: not "still telling the server".
    chmodSync(configDir, 0o500);
    try {
      const refused = await runner.remove({ login });
      expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/EACCES|permission denied/i) });
      expect(refused).not.toHaveProperty("pending");
    } finally {
      chmodSync(configDir, 0o755);
    }
    expect(await runner.remove({ login })).toEqual({ ok: true });
    expect(await runner.entries(login)).toEqual([]);
    runner.quit();
  });

  it("gives the projects the agent may work in, as its own login says, and the runner's log", async () => {
    const { runner, login, configDir } = setUp();
    const projects = await runner.projects(login);
    expect(projects.ok && projects.projects.slice(0, 3)).toEqual([
      { key: "SVA", name: "Samurai vs Aliens" },
      { key: "GS", name: "Getting started" },
      { key: "ART", name: "ART" },
    ]);
    expect(await runner.projects(join(configDir, "nobody.json"))).toEqual({
      ok: false,
      error: "cannot reach https://q.example: connection refused",
    });
    expect(await runner.logFile()).toBe(join(configDir, "runner", "runner.log"));
    // Only what has a project key's form is shown, and handed back to quadit run add.
    const odd = join(configDir, "odd.json");
    const me = { handle: "@odd", kind: "agent", projects: ["SVA", "sva", "GS\nrm -rf ~", 7] };
    writeFileSync(odd, JSON.stringify({ url: "https://q.example", token: "qd_z", me }));
    expect(await runner.projects(odd)).toEqual({ ok: true, projects: [{ key: "SVA", name: "SVA" }] });
  });

  it("says what adding a project would start at once, and nothing it cannot tell", async () => {
    const { runner, login, configDir, quadit } = setUp();
    const saved = JSON.parse(readFileSync(login, "utf8")) as Record<string, unknown>;
    const tasks = [
      { key: "SVA-1", title: "Line 0" },
      { key: "bad key", title: "dropped" },
      { key: "SVA-3", title: "Line 2" },
    ];
    writeFileSync(login, JSON.stringify({ ...saved, waiting: { SVA: { runs: 7, tasks } } }));
    expect(await runner.waiting(login, "SVA")).toEqual({
      agent: "@claude",
      runs: 7,
      tasks: [
        { key: "SVA-1", title: "Line 0" },
        { key: "SVA-3", title: "Line 2" },
      ],
    });
    expect(await runner.waiting(login, "GS")).toEqual({ agent: "@claude", runs: 0, tasks: [] });
    // Refused, or not reached: nothing said.
    expect(await runner.waiting(login, "XYZ")).toBeNull();
    expect(await runner.waiting(join(configDir, "nobody.json"), "SVA")).toBeNull();
    // A quadit from before the form: it refuses the form, and nothing is said either.
    writeFileSync(quadit, "#!/bin/sh\necho 'usage: quadit run …' >&2\nexit 1\n");
    expect(await runner.waiting(login, "SVA")).toBeNull();
  });

  it("gives this computer's name and the ids of the projects it runs a login's agent for", async () => {
    const { runner, login, otherLogin, game, site } = setUp();
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    await runner.add({ login: otherLogin, project: "GS", folder: site, program: "codex" });
    expect(await runner.projectsOf(login)).toEqual({ machine: "Test Mac", projects: ["id-SVA"] });
    expect(await runner.projectsOf("")).toEqual({ machine: "Test Mac", projects: [] });
    runner.quit();
  });

  it("offers nothing without a quadit of the app's own, and has nothing to remove", async () => {
    const runner = new Runner({
      quadit: () => null,
      path: async () => "",
      env: {},
      start: startChild,
      log: () => {},
      changed: () => {},
    });
    expect(runner.available).toBe(false);
    expect(await runner.entries("/x.json")).toBeNull();
    expect(await runner.remove({ login: "/x.json" })).toEqual({ ok: true });
    expect(await runner.add({ login: "/x.json", project: "SVA", folder: "/x", program: "claude" })).toMatchObject({
      ok: false,
    });
  });
});

posixOnly("Runner, under the real guard", () => {
  it("ends the runner at quit, and the programs it started in groups of their own are gone within the guard's grace", async () => {
    // The stand-in runner starts a program of its own when asked to.
    const { runner, login, game, logged } = setUp({ start: startChild, env: { FAKE_RUN_PROGRAM: "1" } });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await runner.add({ login, project: "SVA", folder: game, program: "claude" });
    await until(() => logged.some((line) => line.startsWith("program ")));
    const program = Number(logged.find((line) => line.startsWith("program "))?.split(" ")[1]);
    expect(alive(program)).toBe(true);
    let state = "";
    await until(() => {
      void runner.entries(login).then((entries) => (state = entries?.[0]?.status.state ?? ""));
      return state === "ready";
    });
    runner.quit();
    await until(() => !alive(program), 5_000);
  }, 15_000);
});

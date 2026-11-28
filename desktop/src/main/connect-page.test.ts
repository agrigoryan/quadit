import type { WebContents, WebContentsView } from "electron";
import { describe, expect, it } from "vitest";
import type { PageHandlers } from "@/main/app-pages";
import { ConnectPage } from "@/main/connect-page";
import type { ConnectionRef, ConnectTarget, RunEntryView } from "@/shared/pages-api";

const CLAUDE = "0190f3a2-7b1c-7d4e-9a0b-1c2d3e4f5a6b";
const HELPER = "0190f3a2-7b1c-7d4e-9a0b-1c2d3e4f5a6c";

/** The connection of the tool `tool` in the workspace w1 of the server s1, as a card names it. */
const ref = (tool: string): ConnectionRef => ({ tool, serverId: "s1", workspaceId: "w1", agentId: `as-${tool}` });

/** An entry of quadit run's registry, ready. */
const entry = (id: string, project: string): RunEntryView => ({
  id,
  project,
  folder: "~/game",
  program: "claude",
  status: { state: "ready" },
  blocked: [],
});

/**
 * Connect agents over stand-ins: each view is `{ webContents: { id } }`; the
 * windows record what they are asked, and the window of the server
 * `covered`, when given, has another of the app's pages over it already;
 * "local" is the server the app runs on this computer. Quadit runs Claude
 * Code as @claude (its login /q/claude.json) for SVA, and Codex as @codex
 * for GS; `available`: the app carries a quadit. With `workspace`, each
 * window shows the workspace w1, whose agents are @claude (Claude Code works
 * as it here, on s1 and local only) and @helper (no tool works as it).
 */
function harness({
  covered = "",
  available = true,
  unreadable = false,
  workspace = false,
}: { covered?: string; available?: boolean; unreadable?: boolean; workspace?: boolean } = {}) {
  let handlers: Partial<PageHandlers> = {};
  const said: string[] = [];
  const identity = (agent: string) => ({ server: "https://s1.example", workspace: "w1", agent });
  const logins: Record<string, { login: string; agent: string; program: "claude" | "codex"; identity: object }> = {
    claude: { login: "/q/claude.json", agent: "@claude", program: "claude", identity: identity("as-claude") },
    codex: { login: "/q/codex.json", agent: "@codex", program: "codex", identity: identity("as-codex") },
  };
  // Quadit's runs, by agent: never by login file.
  const entries: Record<string, RunEntryView[]> = {
    "as-claude": [entry("e1", "SVA")],
    "as-codex": [entry("e2", "GS")],
  };
  const closers = new Map<number, () => void>();
  let views = 0;
  const viewId = (view: WebContentsView) => (view.webContents as unknown as { id: number }).id;
  const connect = new ConnectPage({
    pages: {
      answer: (given) => (handlers = { ...handlers, ...given }),
      view: () => ({ webContents: { id: ++views } }) as unknown as WebContentsView,
      changed: () => void said.push("changed"),
    },
    connections: {
      dropPlans: () => void said.push("drop plans"),
      state: async (at: unknown) => ({ harnesses: [], at }),
      tie: async (r: ConnectionRef, folder: string) => {
        said.push(`tie ${r.tool} ${r.workspaceId} ${folder}`);
        return { ok: true };
      },
      runAs: (r: ConnectionRef) => (r.workspaceId === "w1" ? (logins[r.tool] ?? null) : null),
      agentsOf: (serverId: string, workspaceId: string) =>
        (serverId === "s1" || serverId === "local") && workspaceId === "w1"
          ? [
              { tool: "claude", name: "Claude Code", agent: CLAUDE, login: "/q/claude.json" },
              { tool: "codex", name: "Codex", agent: CLAUDE, login: "/q/codex.json" },
            ]
          : [],
      skillForRuns: async (id: string) =>
        id === "codex" ? { ok: false, error: "The Quadit skill for Codex was changed by hand…" } : { ok: true },
    } as unknown as ConstructorParameters<typeof ConnectPage>[0]["connections"],
    windows: {
      cover: (view, serverId, closed) => {
        if (serverId === covered) {
          said.push(`front ${serverId}`);
          return undefined;
        }
        said.push(`cover ${serverId} with ${viewId(view)}`);
        closers.set(viewId(view), closed);
        return { donor: null };
      },
      uncover: (view) => void said.push(`uncover ${viewId(view)}`),
      isCovered: (serverId) => serverId === covered,
    },
    isLocal: (serverId) => serverId === "local",
    target: (serverId): Omit<ConnectTarget, "openedByPage"> => ({
      serverId,
      serverName: `Server ${serverId}`,
      summary: workspace
        ? {
            workspace: { id: "w1", slug: "acme", name: "Acme" },
            me: { name: "Ann", canCreateAgents: true },
            waiting: [],
            agents: [
              { id: CLAUDE, handle: "claude", name: "Claude", state: "idle", detail: "", path: "/acme", usable: true },
              { id: HELPER, handle: "helper", name: "Helper", state: "idle", detail: "", path: "/acme", usable: true },
            ],
            projects: [],
          }
        : null,
    }),
    copy: async () => {},
    selfRuns: { self: () => null, logOf: (id) => `/logs/${id}.log` },
    showLog: async (path) => void said.push(`show ${path}`),
    showBackups: async () => {},
    runner: {
      available,
      entries: async (of) => (unreadable ? null : (entries[of.agent] ?? [])),
      projects: async (login, workspace) => ({
        ok: true,
        projects: [{ key: login, name: `as asked in ${workspace}` }],
      }),
      waiting: async (login, project) => {
        said.push(`waiting ${login} ${project}`);
        return { agent: "@claude", runs: 1, tasks: [{ key: `${project}-1`, title: "First" }] };
      },
      add: async (a) => {
        said.push(`add ${JSON.stringify(a)}`);
        return { ok: true };
      },
      remove: async (by) => {
        said.push(`remove ${JSON.stringify(by)}`);
        return { ok: true };
      },
      logFile: async () => "/q/runner/runner.log",
    },
    programOf: async (id) => (id === "claude" ? "/h/.local/bin/claude" : null),
    pickFolder: async (sender) => ((sender as unknown as { id: number }).id === 1 ? "/h/devel/game" : null),
    home: "/h",
  });
  /** Calls the page's method `name` as the page in the view `view` (its number) would. */
  const call = <K extends keyof PageHandlers>(view: number, name: K, ...args: unknown[]) =>
    (handlers[name] as (sender: WebContents, ...rest: unknown[]) => unknown)(
      { id: view } as unknown as WebContents,
      ...args,
    );
  return { connect, said, closers, call };
}

describe("ConnectPage", () => {
  it("lays Connect agents over the window of the server asked for, and Done takes it away and the plan under review", async () => {
    const { connect, said, call } = harness();
    connect.show("s1");
    expect(await call(1, "connectTarget")).toEqual({
      serverId: "s1",
      serverName: "Server s1",
      summary: null,
      openedByPage: false,
    });
    await call(1, "closeConnect");
    expect(said).toEqual(["cover s1 with 1", "uncover 1", "drop plans"]);
    // Gone, it is over no window.
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("brings itself to the front when asked again for the same window, and moves when asked for another's", () => {
    const { connect, said } = harness();
    connect.show("s1");
    connect.show("s1");
    connect.show("s2");
    expect(said).toEqual(["cover s1 with 1", "cover s1 with 1", "uncover 1", "drop plans", "cover s2 with 2"]);
  });

  it("goes when the window under it is closed", async () => {
    const { connect, said, closers, call } = harness();
    connect.show("s1");
    closers.get(1)?.();
    expect(said.slice(1)).toEqual(["uncover 1", "drop plans"]);
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("lays nothing over a window another of the app's pages covers (the first run)", async () => {
    const { connect, said, call } = harness({ covered: "s1" });
    connect.show("s1");
    expect(said).toEqual(["front s1", "uncover 1"]);
    expect(await call(1, "connectTarget")).toBeNull();
  });

  it("tells its page of the tools as seen from the workspace under it, and of none before the window shows one", async () => {
    const { connect, call } = harness({ workspace: true });
    connect.show("s2");
    expect(await call(1, "connectState")).toMatchObject({ at: { serverId: "s2", workspaceId: "w1" } });
    const bare = harness();
    bare.connect.show("s2");
    expect(await bare.call(1, "connectState")).toMatchObject({ at: null });
    // A page not its own: from none.
    expect(await bare.call(7, "connectState")).toMatchObject({ at: null });
  });

  it("asks about a connection named whole, never another workspace's of the same tool", async () => {
    const { connect, call } = harness();
    connect.show("s1");
    expect(await call(1, "runEntries", { ...ref("claude"), workspaceId: "w2" })).toBeNull();
    expect(await call(1, "runEntries", "claude")).toBeNull();
  });

  it("ties only a whole folder to a connection's workspace", async () => {
    const { connect, said, call } = harness();
    connect.show("s1");
    expect(await call(1, "tieFolder", ref("claude"), "/h/devel/site")).toEqual({ ok: true });
    for (const folder of ["devel/site", "/h/a\0b", 7])
      expect(await call(1, "tieFolder", ref("claude"), folder)).toEqual({
        ok: false,
        error: "Choose the folder again.",
      });
    expect(said.filter((line) => line.startsWith("tie "))).toEqual(["tie claude w1 /h/devel/site"]);
  });

  it("tells and obeys only its own page", async () => {
    const { connect, said, call } = harness();
    connect.show("s1");
    expect(await call(7, "connectTarget")).toBeNull();
    await call(7, "closeConnect");
    expect(said).toEqual(["cover s1 with 1"]);
  });
});

describe("ConnectPage, Run by Quadit", () => {
  it("gives a tool's agent and its entries, and nothing for a tool Quadit cannot run or an app without a quadit", async () => {
    const { call } = harness();
    expect(await call(1, "runEntries", ref("claude"))).toEqual({ agent: "@claude", entries: [entry("e1", "SVA")] });
    expect(await call(1, "runEntries", ref("gemini"))).toBeNull();
    expect(await harness({ available: false }).call(1, "runEntries", ref("claude"))).toBeNull();
  });

  it("says when what Quadit runs could not be read, rather than that it runs nothing", async () => {
    expect(await harness({ unreadable: true }).call(1, "runEntries", ref("claude"))).toEqual({
      agent: "@claude",
      entries: [],
      unreadable: true,
    });
  });

  it("hands quadit run add only a project key and a whole folder path, refusing anything else in plain words", async () => {
    const { call, said } = harness();
    for (const project of ["sva", "SVA\nrm -rf ~", "", 7])
      expect(await call(1, "startRunning", ref("claude"), project, "/h/devel/game")).toEqual({
        ok: false,
        error: "That is not a project of this workspace.",
      });
    for (const folder of ["devel/game", "/h/devel\0/game", "", null])
      expect(await call(1, "startRunning", ref("claude"), "SVA", folder)).toEqual({
        ok: false,
        error: "Choose the folder again.",
      });
    expect(said).toEqual([]);
  });

  it("tells what running a project would start, asked as the tool's own login, for a project key only", async () => {
    const { call, said } = harness();
    expect(await call(1, "runWaiting", ref("claude"), "SVA")).toEqual({
      agent: "@claude",
      runs: 1,
      tasks: [{ key: "SVA-1", title: "First" }],
    });
    expect(await call(1, "runWaiting", ref("claude"), "sva; rm")).toBeNull();
    expect(await call(1, "runWaiting", ref("gemini"), "SVA")).toBeNull();
    expect(said).toEqual(["waiting /q/claude.json SVA"]);
  });

  it("asks the projects as the tool's own login", async () => {
    const { call } = harness();
    expect(await call(1, "agentProjects", ref("codex"))).toEqual({
      ok: true,
      projects: [{ key: "/q/codex.json", name: "as asked in w1" }],
    });
    expect(await call(1, "agentProjects", ref("gemini"))).toMatchObject({ ok: false });
  });

  it("starts running a project with the tool's login, program and the program the app finds", async () => {
    const { call, said } = harness();
    expect(await call(1, "startRunning", ref("claude"), "SVA", "/h/devel/game")).toEqual({ ok: true });
    expect(said).toEqual([
      `add ${JSON.stringify({ login: "/q/claude.json", project: "SVA", folder: "/h/devel/game", program: "claude", programPath: "/h/.local/bin/claude" })}`,
    ]);
  });

  it("starts no run of an agent whose skill lacks the section for runs, saying why", async () => {
    const { call, said } = harness();
    expect(await call(1, "startRunning", ref("codex"), "GS", "/h/devel/site")).toEqual({
      ok: false,
      error: "The Quadit skill for Codex was changed by hand…",
    });
    expect(said).toEqual([]);
  });

  it("stops running only an entry of the tool's own agent", async () => {
    const { call, said } = harness();
    expect(await call(1, "stopRunning", ref("claude"), "e2")).toEqual({
      ok: false,
      error: "Quadit does not run that project for @claude.",
    });
    expect(said).toEqual([]);
    expect(await call(1, "stopRunning", ref("claude"), "e1")).toEqual({ ok: true });
    expect(said).toEqual([`remove ${JSON.stringify({ entry: "e1" })}`]);
  });

  it("gives the folder picked over the page's window as a person writes it, and opens the runner's log", async () => {
    const { call, said } = harness();
    expect(await call(1, "pickFolder")).toEqual({ path: "/h/devel/game", shown: "~/devel/game" });
    expect(await call(2, "pickFolder")).toBeNull();
    await call(1, "showRunnerLog");
    expect(said).toEqual(["show /q/runner/runner.log"]);
  });
});

describe("ConnectPage, asked by a page at one of its agents", () => {
  it("opens at the card of the tool that works as that agent, for what the page meant", async () => {
    const { connect, call } = harness({ workspace: true });
    connect.asked("local", { agent: CLAUDE, intent: "run" });
    expect(await call(1, "connectTarget")).toMatchObject({
      openedByPage: false,
      focus: { id: 1, intent: "run", tool: "claude", agent: { id: CLAUDE, handle: "claude" } },
    });
  });

  it("opens at the card of the program the page named, of two that work as that agent, else the first", async () => {
    const { connect, call } = harness({ workspace: true });
    connect.asked("local", { agent: CLAUDE, intent: "run", program: "codex" });
    expect(await call(1, "connectTarget")).toMatchObject({ focus: { tool: "codex" } });
    // Named, but not working as that agent here (disconnected since): the first that does.
    connect.asked("local", { agent: CLAUDE, intent: "run", program: "gemini" });
    expect(await call(1, "connectTarget")).toMatchObject({ focus: { id: 2, tool: "claude" } });
  });

  it("names the agent to connect a tool as when no tool works as it here", async () => {
    const { connect, call } = harness({ workspace: true });
    connect.asked("local", { agent: HELPER, intent: "connect" });
    const target = (await call(1, "connectTarget")) as ConnectTarget;
    expect(target.focus).toEqual({ id: 1, intent: "connect", agent: { id: HELPER, handle: "helper" } });
  });

  it("opens as without a focus for an agent the workspace shown does not have, or before it shows one", async () => {
    const shown = harness({ workspace: true });
    shown.connect.asked("local", { agent: "0190f3a2-7b1c-7d4e-9a0b-1c2d3e4f5a6d", intent: "connect" });
    expect(await shown.call(1, "connectTarget")).not.toHaveProperty("focus");
    const none = harness();
    none.connect.asked("local", { agent: CLAUDE, intent: "run" });
    expect(await none.call(1, "connectTarget")).not.toHaveProperty("focus");
  });

  it("holds input on another server's page as before, and finds only that server's tools", async () => {
    const { connect, call } = harness({ workspace: true });
    connect.asked("s2", { agent: CLAUDE, intent: "disconnect" });
    expect(await call(1, "connectTarget")).toMatchObject({
      openedByPage: true,
      // Claude Code works as @claude of s1 and of this computer's server, not of s2: no card to go to there.
      focus: { id: 1, intent: "disconnect", agent: { id: CLAUDE, handle: "claude" } },
    });
    expect(((await call(1, "connectTarget")) as ConnectTarget).focus).not.toHaveProperty("tool");
  });

  it("takes a new focus while it is there, telling its page, each with its own number", async () => {
    const { connect, call, said } = harness({ workspace: true });
    connect.asked("local", { agent: CLAUDE });
    connect.asked("local", { agent: CLAUDE, intent: "disconnect" });
    expect(said).toEqual(["cover local with 1", "changed"]);
    expect(await call(1, "connectTarget")).toMatchObject({ focus: { id: 2, intent: "disconnect", tool: "claude" } });
    // Asked again without one: nothing changes.
    connect.asked("local");
    expect(said).toEqual(["cover local with 1", "changed"]);
  });
});

describe("ConnectPage, asked by a server's page", () => {
  it("opens over that page's window, telling its page that another server's page asked", async () => {
    const { connect, said, call } = harness();
    connect.asked("s1");
    expect(said).toEqual(["cover s1 with 1"]);
    expect(await call(1, "connectTarget")).toMatchObject({ serverName: "Server s1", openedByPage: true });
    // Asked again while it is there: nothing more.
    connect.asked("s1");
    expect(said).toEqual(["cover s1 with 1"]);
    // Left, it may ask again at once.
    await call(1, "closeConnect");
    connect.asked("s1");
    expect(said.at(-1)).toBe("cover s1 with 2");
  });

  it("opens for the app's own server's page as the person would: nothing held, nothing said of who asked", async () => {
    const { connect, call } = harness();
    connect.asked("local");
    expect(await call(1, "connectTarget")).toMatchObject({ openedByPage: false });
  });

  it("never opens while the first run covers the window, nor brings that window forward", () => {
    const { connect, said } = harness({ covered: "s1" });
    connect.asked("s1");
    expect(said).toEqual([]);
  });
});

import type { WebContents, WebContentsView } from "electron";
import { describe, expect, it } from "vitest";
import type { PageHandlers } from "@/main/app-pages";
import { ConnectPage } from "@/main/connect-page";
import type { ConnectTarget, RunEntryView } from "@/shared/pages-api";

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
 * for GS; `available`: the app carries a quadit.
 */
function harness({
  covered = "",
  available = true,
  unreadable = false,
}: { covered?: string; available?: boolean; unreadable?: boolean } = {}) {
  let handlers: Partial<PageHandlers> = {};
  const said: string[] = [];
  const logins: Record<string, { login: string; agent: string; program: "claude" | "codex" }> = {
    claude: { login: "/q/claude.json", agent: "@claude", program: "claude" },
    codex: { login: "/q/codex.json", agent: "@codex", program: "codex" },
  };
  const entries: Record<string, RunEntryView[]> = {
    "/q/claude.json": [entry("e1", "SVA")],
    "/q/codex.json": [entry("e2", "GS")],
  };
  const closers = new Map<number, () => void>();
  let views = 0;
  const viewId = (view: WebContentsView) => (view.webContents as unknown as { id: number }).id;
  const connect = new ConnectPage({
    pages: {
      answer: (given) => (handlers = { ...handlers, ...given }),
      view: () => ({ webContents: { id: ++views } }) as unknown as WebContentsView,
    },
    connections: {
      dropPlans: () => void said.push("drop plans"),
      runAs: (id: string) => logins[id] ?? null,
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
      summary: null,
    }),
    copy: async () => {},
    selfRuns: { self: () => null, logOf: (id) => `/logs/${id}.log` },
    showLog: async (path) => void said.push(`show ${path}`),
    showBackups: async () => {},
    runner: {
      available,
      entries: async (login) => (unreadable ? null : (entries[login] ?? [])),
      projects: async (login) => ({ ok: true, projects: [{ key: login, name: "as asked" }] }),
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
    expect(await call(1, "runEntries", "claude")).toEqual({ agent: "@claude", entries: [entry("e1", "SVA")] });
    expect(await call(1, "runEntries", "gemini")).toBeNull();
    expect(await harness({ available: false }).call(1, "runEntries", "claude")).toBeNull();
  });

  it("says when what Quadit runs could not be read, rather than that it runs nothing", async () => {
    expect(await harness({ unreadable: true }).call(1, "runEntries", "claude")).toEqual({
      agent: "@claude",
      entries: [],
      unreadable: true,
    });
  });

  it("hands quadit run add only a project key and a whole folder path, refusing anything else in plain words", async () => {
    const { call, said } = harness();
    for (const project of ["sva", "SVA\nrm -rf ~", "", 7])
      expect(await call(1, "startRunning", "claude", project, "/h/devel/game")).toEqual({
        ok: false,
        error: "That is not a project of this workspace.",
      });
    for (const folder of ["devel/game", "/h/devel\0/game", "", null])
      expect(await call(1, "startRunning", "claude", "SVA", folder)).toEqual({
        ok: false,
        error: "Choose the folder again.",
      });
    expect(said).toEqual([]);
  });

  it("asks the projects as the tool's own login", async () => {
    const { call } = harness();
    expect(await call(1, "agentProjects", "codex")).toEqual({
      ok: true,
      projects: [{ key: "/q/codex.json", name: "as asked" }],
    });
    expect(await call(1, "agentProjects", "gemini")).toMatchObject({ ok: false });
  });

  it("starts running a project with the tool's login, program and the program the app finds", async () => {
    const { call, said } = harness();
    expect(await call(1, "startRunning", "claude", "SVA", "/h/devel/game")).toEqual({ ok: true });
    expect(said).toEqual([
      `add ${JSON.stringify({ login: "/q/claude.json", project: "SVA", folder: "/h/devel/game", program: "claude", programPath: "/h/.local/bin/claude" })}`,
    ]);
  });

  it("starts no run of an agent whose skill lacks the section for runs, saying why", async () => {
    const { call, said } = harness();
    expect(await call(1, "startRunning", "codex", "GS", "/h/devel/site")).toEqual({
      ok: false,
      error: "The Quadit skill for Codex was changed by hand…",
    });
    expect(said).toEqual([]);
  });

  it("stops running only an entry of the tool's own agent", async () => {
    const { call, said } = harness();
    expect(await call(1, "stopRunning", "claude", "e2")).toEqual({
      ok: false,
      error: "Quadit does not run that project for @claude.",
    });
    expect(said).toEqual([]);
    expect(await call(1, "stopRunning", "claude", "e1")).toEqual({ ok: true });
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

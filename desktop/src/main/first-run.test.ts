import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContentsView } from "electron";
import { describe, expect, it } from "vitest";
import type { PageHandlers } from "@/main/app-pages";
import { FirstConnect } from "@/main/first-connect";
import { FirstRun } from "@/main/first-run";
import { ServerStore } from "@/main/servers";
import { Settings } from "@/main/settings";
import type { DesktopOutcome, DesktopRequest } from "@/shared/bridge";
import type { AddResult } from "@/shared/pages-api";

const SAMPLES: DesktopOutcome = { ok: true, path: "/personal/projects/GS" };

type SetUp = { ok: true; serverId: string; workspace: string | null } | { ok: false; error: string };

/** A promise and the function that settles it, for work a test holds until it lets it go. */
function held<T>(): { promise: Promise<T>; settle(value: T): void } {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (settle = done));
  return { promise, settle };
}

/**
 * A first run over stand-ins: the server list sets up with what `setUp`
 * gives and adds with what `add` gives; the windows record what they are
 * asked, a cover over no server giving the id "waiting-<n>"; the tools step
 * finds no tool, and the workspace's page answers the samples with `answer`.
 * The window of the server `covered`, when given, has another of the app's
 * pages over it: nothing more covers it.
 */
function harness({
  setUp = () => Promise.resolve<SetUp>({ ok: false, error: "not asked for" }),
  add = () => Promise.resolve<AddResult>({ ok: false, error: "not asked for" }),
  answer = SAMPLES,
  covered,
}: {
  setUp?: () => Promise<SetUp>;
  add?: () => Promise<AddResult>;
  answer?: DesktopOutcome;
  covered?: () => string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quadit-desktop-first-run-"));
  const settings = new Settings(join(dir, "settings.json"));
  const store = new ServerStore(join(dir, "servers.json"));
  let handlers: Partial<PageHandlers> = {};
  const covers: { serverId: string | null; closed: () => void }[] = [];
  const said: string[] = [];
  const setUps: (string | undefined)[] = [];
  const adds: (string | undefined)[] = [];
  const asked: DesktopRequest[] = [];
  let views = 0;
  const firstRun = new FirstRun({
    pages: {
      answer: (given) => (handlers = { ...handlers, ...given }),
      // Only the windows stand-in sees it.
      view: () => ({ id: ++views }) as unknown as WebContentsView,
    },
    settings,
    store,
    accountName: async () => "Lou Local",
    list: {
      setUpHere: (_name, id) => {
        setUps.push(id);
        return setUp();
      },
      add: (_address, _name, _insecure, id) => {
        adds.push(id);
        return add();
      },
      localServer: () => store.byOrigin("http://127.0.0.1:4780"),
    },
    windows: {
      cover: (_view, serverId, closed) => {
        if (serverId && serverId === covered?.()) {
          said.push(`front ${serverId}`);
          return undefined;
        }
        covers.push({ serverId, closed });
        said.push(`cover ${serverId ?? "new"}`);
        return { donor: serverId ? null : `waiting-${covers.length}` };
      },
      uncover: () => void said.push("uncover"),
      openCoveredPath: async (serverId, path) => {
        said.push(`show ${serverId} ${path}`);
        return true;
      },
      showAfresh: (serverId, path) => void said.push(`afresh ${serverId} ${path}`),
    },
    toolsStep: (serverId, workspace) =>
      new FirstConnect(
        {
          connections: {
            state: async () => ({
              harnesses: [],
              cli: {
                found: "/bin/quadit",
                version: "1",
                linkInto: null,
                profile: null,
                pathFolder: null,
                manual: null,
              },
              defaultLogin: null,
              claudePlugin: false,
            }),
            planConnect: async () => ({ ok: false, error: "none" }),
            applyConnect: async () => ({ ok: false, error: "none" }),
            planDisconnect: () => ({ ok: false, error: "none" }),
            applyDisconnect: async () => ({ ok: false, error: "none" }),
            dropPlans: () => {},
          },
          summaries: () => [
            {
              serverId,
              listening: true,
              summary: {
                workspace: { id: "w1", slug: workspace, name: "Personal" },
                me: { name: "Lou", canCreateAgents: true },
                waiting: [],
                agents: [],
                projects: [],
              },
            },
          ],
          ask: async (_server, _workspace, request) => {
            asked.push(request);
            return answer;
          },
          sleep: async () => {},
        },
        serverId,
        workspace,
      ),
  });
  /** Calls the page's method `name` as the first run's page would. */
  const call = <K extends keyof PageHandlers>(name: K, ...args: unknown[]) =>
    (handlers[name] as (sender: unknown, ...rest: unknown[]) => unknown)({}, ...args);
  return { firstRun, settings, store, covers, said, setUps, adds, asked, call };
}

describe("FirstRun", () => {
  it("starts the app on its very first start, and while a tools step is owed to a server still in the list", () => {
    const { firstRun, settings, store } = harness();
    expect(firstRun.due()).toBe(true);
    settings.change({ setupDone: true });
    expect(firstRun.due()).toBe(false);
    const server = store.add("http://127.0.0.1:4780", "This computer", { handoff: 1, inset: 1 });
    settings.change({ pendingFirstRun: { serverId: server.id, workspace: "personal", person: "Lou" } });
    expect(firstRun.due()).toBe(true);
    settings.change({ pendingFirstRun: { serverId: "gone", workspace: "personal", person: "Lou" } });
    expect(firstRun.due()).toBe(false);
  });

  it("sets a new install up in the window made for it: the tools step is owed, its workspace loads, and the end shows the samples", async () => {
    const { firstRun, settings, said, setUps, asked, call } = harness({
      setUp: async () => ({ ok: true, serverId: "waiting-1", workspace: "personal" }),
    });
    firstRun.show();
    expect(await call("setUpHere", "Lou Local")).toEqual({ ok: true, next: "tools" });
    expect(setUps).toEqual(["waiting-1"]);
    expect(settings.get().pendingFirstRun).toEqual({
      serverId: "waiting-1",
      workspace: "personal",
      person: "Lou Local",
    });
    expect(await call("firstRunStep")).toEqual({ step: "tools", person: "Lou Local" });
    expect(await call("finishFirstRun")).toEqual({ ok: true });
    expect(asked).toEqual([{ kind: "samples" }]);
    // The page goes once the window shows the samples.
    await call("endFirstRun");
    expect(said).toEqual([
      "cover new",
      "afresh waiting-1 /personal",
      "show waiting-1 /personal/projects/GS",
      "uncover",
    ]);
    expect(settings.get()).toMatchObject({ setupDone: true, pendingFirstRun: null });
  });

  it("opens an install set up before (its data kept) on its workspace, with no tools step and no samples asked for", async () => {
    const { firstRun, settings, said, asked, call } = harness({
      setUp: async () => ({ ok: true, serverId: "local", workspace: null }),
    });
    firstRun.show();
    expect(await call("setUpHere", "Lou Local")).toEqual({ ok: true, next: "workspace" });
    expect(settings.get().pendingFirstRun).toBeNull();
    expect(await call("firstRunStep")).toEqual({ step: "welcome" });
    expect(await call("finishFirstRun")).toMatchObject({ ok: false });
    await call("endFirstRun");
    expect(asked).toEqual([]);
    expect(said).toEqual(["cover new", "afresh local /", "uncover"]);
  });

  it("keeps the first run as it is when the end fails, for the person to try again", async () => {
    const { firstRun, settings, said, call } = harness({
      setUp: async () => ({ ok: true, serverId: "waiting-1", workspace: "personal" }),
      answer: { ok: false, message: "The page does not take requests now." },
    });
    firstRun.show();
    await call("setUpHere", "Lou Local");
    expect(await call("finishFirstRun")).toMatchObject({ ok: false });
    expect(said).not.toContain("uncover");
    expect(settings.get().pendingFirstRun).not.toBeNull();
  });

  it("resumes an owed tools step at the next start, over that server's window", async () => {
    const { firstRun, settings, store, said, call } = harness();
    const server = store.add("http://127.0.0.1:4780", "This computer", { handoff: 1, inset: 1 });
    settings.change({ pendingFirstRun: { serverId: server.id, workspace: "personal", person: "Lou" } });
    firstRun.show();
    expect(said).toEqual([`cover ${server.id}`]);
    expect(await call("firstRunStep")).toEqual({ step: "tools", person: "Lou" });
    expect(await call("lookForTools")).toEqual({ tools: [], addsCommand: false });
  });

  it("is not shown over a window another of the app's pages covers, and stays owed for the next showing", () => {
    let id = "";
    const { firstRun, settings, store, said } = harness({ covered: () => id });
    const server = store.add("http://127.0.0.1:4780", "This computer", { handoff: 1, inset: 1 });
    id = server.id;
    settings.change({ pendingFirstRun: { serverId: server.id, workspace: "personal", person: "Lou" } });
    firstRun.show();
    expect(said).toEqual([`front ${server.id}`, "uncover"]);
    expect(settings.get().pendingFirstRun).not.toBeNull();
    id = "";
    firstRun.show();
    expect(said.at(-1)).toBe(`cover ${server.id}`);
  });

  it("gives away no id of a server already there: a server added over its window gets one of its own", async () => {
    const { firstRun, store, adds, call } = harness({ add: async () => ({ ok: false, error: "no" }) });
    store.add("http://127.0.0.1:4780", "This computer", { handoff: 1, inset: 1 });
    firstRun.show();
    await call("connectServer", "https://q.example");
    expect(adds).toEqual([undefined]);
  });

  it("lets a set-up a closed run began finish, but shows nothing of it, owes no tools step and begins none", async () => {
    const done = held<SetUp>();
    const { firstRun, settings, said, covers, call } = harness({ setUp: () => done.promise });
    firstRun.show();
    const setting = call("setUpHere", "Lou Local");
    covers[0]?.closed();
    done.settle({ ok: true, serverId: "waiting-1", workspace: "personal" });
    expect(await setting).toMatchObject({ ok: false });
    expect(said).toEqual(["cover new", "uncover"]);
    expect(settings.get()).toMatchObject({ setupDone: true, pendingFirstRun: null });
  });

  it("never lets a closed run's late work end a newer run", async () => {
    const added = held<AddResult>();
    const { firstRun, said, covers, call } = harness({ add: () => added.promise });
    firstRun.show();
    const adding = call("connectServer", "https://q.example");
    covers[0]?.closed();
    firstRun.show();
    added.settle({
      ok: true,
      server: { id: "s", name: "q", origin: "https://q.example", transport: "secure", local: false },
    });
    await adding;
    // One uncover: the first run's, when its window closed. The newer one is still shown.
    expect(said).toEqual(["cover new", "uncover", "cover new"]);
  });

  it("shows nothing for an end a closed run asked for", async () => {
    const { firstRun, said, covers, call } = harness({
      setUp: async () => ({ ok: true, serverId: "waiting-1", workspace: "personal" }),
    });
    firstRun.show();
    await call("setUpHere", "Lou Local");
    const finishing = call("finishFirstRun");
    covers[0]?.closed();
    expect(await finishing).toMatchObject({ ok: false });
    expect(said.some((line) => line.startsWith("show "))).toBe(false);
  });
});

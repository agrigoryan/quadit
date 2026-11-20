import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "@/main/probe";
import { ServerStore } from "@/main/servers";

vi.mock("electron", () => ({ ipcMain: { handle() {} }, shell: {}, webContents: { getAllWebContents: () => [] } }));

const { AppPages } = await import("@/main/app-pages");
const { Requests } = await import("@/main/requests");
const { ServerChecks } = await import("@/main/server-checks");
const { LOCAL_NAME, ServerList } = await import("@/main/server-list");

const ORIGIN = "http://127.0.0.1:4780";

type Owner = { ok: true; workspace: string | null } | { ok: false; error: string };

/**
 * A server list whose server on this computer starts at once (or fails to,
 * with `startError`) and answers set-up with `owner`, one answer per call.
 */
function setUp(owner: Owner[], startError?: string) {
  const store = new ServerStore(join(mkdtempSync(join(tmpdir(), "quadit-desktop-list-")), "servers.json"));
  const windowFetches = new Map<string, Fetch>();
  const shown: { serverId: string; path: string }[] = [];
  const ownerAsked: { fetch: Fetch; name: string }[] = [];
  const fetcher: Fetch = async () => new Response(null, { status: 404 });
  const windows = {
    show: () => {},
    // The page starts over: the app changed the window's session under it.
    showAfresh: (serverId: string, path: string) => void shown.push({ serverId, path }),
    fetcher: (serverId: string) => {
      const fetch: Fetch = async () => new Response(null, { status: 404 });
      windowFetches.set(serverId, fetch);
      return fetch;
    },
    forget: async () => {},
    dismissBar: () => {},
    retryFrom: () => {},
  };
  let port: number | null = null;
  const local = {
    available: true,
    dataDir: "/data/server",
    logFile: "/data/server/server.log",
    origin: () => (port === null ? null : ORIGIN),
    state: () => ({ kind: "running" as const }),
    setUp: async () => {
      if (startError) throw new Error(startError);
      port = 4780;
      return ORIGIN;
    },
    setUpOwner: async (fetch: Fetch, name: string) => {
      ownerAsked.push({ fetch, name });
      return owner.shift() ?? { ok: false as const, error: "no answer" };
    },
    start: () => {},
    stop: async () => {},
    restart: async () => {},
  };
  const list = new ServerList(
    store,
    windows,
    new AppPages("file:///app/pages/", "/app/preload.js"),
    new Requests(
      () => false,
      () => {},
    ),
    {
      fetcher,
      checks: new ServerChecks(store, fetcher, () => {}),
      signIn: () => {},
      local,
      loginItem: null,
    },
  );
  return { list, store, shown, ownerAsked, windowFetches };
}

describe("ServerList.setUpHere", () => {
  it("adds the server on this computer, makes its owner through its window's own session, and opens that window on the workspace", async () => {
    const { list, store, shown, ownerAsked, windowFetches } = setUp([{ ok: true, workspace: "personal" }]);
    const done = await list.setUpHere("Lou Local");
    const server = store.byOrigin(ORIGIN);
    expect(done).toEqual({ ok: true, serverId: server?.id, workspace: "personal" });
    expect(server?.name).toBe(LOCAL_NAME);
    expect(list.localServer()?.id).toBe(server?.id);
    expect(ownerAsked).toEqual([{ fetch: windowFetches.get(server?.id ?? ""), name: "Lou Local" }]);
    expect(shown).toEqual([{ serverId: server?.id, path: "/personal" }]);
  });

  it("says which workspace it made with the owner, and none when it signed in to an install set up before, which opens on its own first page", async () => {
    const { list, shown } = setUp([
      { ok: true, workspace: "personal" },
      { ok: true, workspace: null },
    ]);
    expect(await list.setUpHere("Lou Local")).toMatchObject({ workspace: "personal" });
    expect(await list.setUpHere("Lou Local")).toMatchObject({ workspace: null });
    expect(shown.map((open) => open.path)).toEqual(["/personal", "/"]);
  });

  it("says why when it could not, without opening a window", async () => {
    const refused = setUp([{ ok: false, error: "The server on this computer answered: name is required." }]);
    expect(await refused.list.setUpHere("")).toEqual({
      ok: false,
      error: "The server on this computer answered: name is required.",
    });
    expect(refused.shown).toEqual([]);

    const unstartable = setUp([], "This build of the app has no Quadit server to run.");
    expect(await unstartable.list.setUpHere("Lou")).toEqual({
      ok: false,
      error: "This build of the app has no Quadit server to run.",
    });
    expect(unstartable.store.list()).toEqual([]);
    expect(unstartable.ownerAsked).toEqual([]);
  });
});

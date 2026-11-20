import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetch } from "@/main/probe";
import { ServerChecks, type Words } from "@/main/server-checks";
import { ServerStore } from "@/main/servers";

/** A Quadit server whose version answer can change, as one being upgraded; null is a server that does not answer. */
/** What a server's version answer says. */
type Says = { version: string; handoff: number; inset?: number };

function upgradable(start: Says | null) {
  let now = start;
  const fetcher: Fetch = async () => {
    if (!now) throw new TypeError("fetch failed");
    return Response.json({ name: "quadit", version: now.version, desktop: { handoff: now.handoff, inset: now.inset } });
  };
  return { fetcher, set: (next: typeof start) => (now = next) };
}

function setUp(start: Says | null, handoffAdded = 1) {
  const store = new ServerStore(join(mkdtempSync(join(tmpdir(), "quadit-desktop-checks-")), "servers.json"));
  const server = store.add("https://quadit.example.com", "Work", { handoff: handoffAdded, inset: 0 });
  const told: Words[] = [];
  const remote = upgradable(start);
  const checks = new ServerChecks(store, remote.fetcher, (words) => told.push(words));
  return { store, server, told, remote, checks };
}

describe("ServerChecks", () => {
  it("asks every server at start, keeps its answer, and says once per version when it does not fit", async () => {
    const { store, server, told, remote, checks } = setUp({ version: "2.0.0", handoff: 2 });
    await checks.checkAll();
    expect(store.get(server.id)?.handoff).toBe(2);
    expect(told).toEqual([{ title: "Work needs a newer Quadit app", detail: expect.stringContaining("Quadit 2.0.0") }]);

    // Started again on the same server: said already.
    await checks.checkAll();
    expect(told).toHaveLength(1);

    // Downgraded below the hand-off: said, as something else.
    remote.set({ version: "0.9.0", handoff: 0 });
    await checks.checkAll();
    expect(told.at(-1)).toEqual({
      title: "Work is older than this app",
      detail: expect.stringContaining("Quadit 0.9.0"),
    });
    expect(store.get(server.id)?.handoff).toBe(0);

    // Fits again: nothing to say.
    remote.set({ version: "1.0.0", handoff: 1 });
    await checks.checkAll();
    expect(told).toHaveLength(2);
    expect(store.get(server.id)?.handoff).toBe(1);
  });

  it("keeps which window without a title bar a server's pages are laid out for, as it changes", async () => {
    const { store, server, remote, checks } = setUp({ version: "2.0.0", handoff: 1, inset: 1 });
    await checks.check(server.id);
    expect(store.get(server.id)?.inset).toBe(1);
    remote.set({ version: "1.0.0", handoff: 1 });
    await checks.check(server.id);
    expect(store.get(server.id)?.inset).toBe(0);
  });

  it("keeps what a server said last when it does not answer", async () => {
    const { store, server, told, checks } = setUp(null, 1);
    await checks.checkAll();
    expect(store.get(server.id)?.handoff).toBe(1);
    expect(told).toEqual([]);
  });

  it("lets the browser sign-in start only on a server that fits, asking it first", async () => {
    const { server, remote, checks } = setUp({ version: "1.0.0", handoff: 1 });
    expect(await checks.whyNoSignIn(server.id)).toBeNull();

    // Upgraded since the app started: the sign-in asks again and is refused.
    remote.set({ version: "2.0.0", handoff: 2 });
    expect(await checks.whyNoSignIn(server.id)).toEqual({
      title: "Work needs a newer Quadit app",
      detail: expect.stringContaining("Quadit 2.0.0"),
    });

    // Not answering now: judged by its last answer.
    remote.set(null);
    expect(await checks.whyNoSignIn(server.id)).toMatchObject({ title: "Work needs a newer Quadit app" });
    expect(await checks.whyNoSignIn("removed")).toMatchObject({ title: "This server was removed" });
  });
});

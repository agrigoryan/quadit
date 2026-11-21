import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Requests } from "@/main/requests";
import type { DesktopRequest, DesktopSummary } from "@/shared/bridge";

function summaryOf(workspace: string, requests: string[] = []): DesktopSummary {
  return {
    workspace: { id: workspace, slug: workspace, name: workspace },
    me: { name: "Ann", canCreateAgents: true },
    waiting: [
      { title: "Ship?", detail: "", path: "/x", actions: requests.map((request) => ({ label: "Go", request })) },
    ],
    agents: [],
    projects: [],
  };
}

/** Requests with stand-in pages: each page that is alive records what it was sent. */
function setUp() {
  const sent = new Map<number, { id: string; request: DesktopRequest }[]>();
  const alive = new Set<number>();
  let changes = 0;
  const requests = new Requests(
    (page, message) => {
      if (!alive.has(page)) return false;
      sent.set(page, [...(sent.get(page) ?? []), message]);
      return true;
    },
    () => void changes++,
  );
  const page = (id: number, serverId: string, workspace?: string, actions: string[] = []) => {
    alive.add(id);
    requests.listen(id, serverId, true);
    if (workspace) requests.publish(id, serverId, summaryOf(workspace, actions));
  };
  const lastTo = (page: number) => sent.get(page)?.at(-1);
  return { requests, page, alive, sent, lastTo, changes: () => changes };
}

describe("Requests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a request to the page that published the workspace and gives its answer", async () => {
    const { requests, page, lastTo, sent } = setUp();
    page(1, "s1", "acme");
    page(2, "s1", "games");
    page(3, "s2", "acme");
    const answer = requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t1" });
    const message = lastTo(1);
    expect(message?.request).toEqual({ kind: "revoke-token", token: "t1" });
    expect(sent.get(2)).toBeUndefined();
    expect(sent.get(3)).toBeUndefined();
    // Only the page it went to can answer it.
    requests.answer(3, { id: message?.id, outcome: { ok: true, path: "/elsewhere" } });
    requests.answer(1, { id: message?.id, outcome: { ok: true, path: "/acme/t/SVA-1" } });
    await expect(answer).resolves.toEqual({ ok: true, path: "/acme/t/SVA-1" });
  });

  it("says which workspace one page shows, until it takes it back or goes", () => {
    const { requests, page } = setUp();
    page(1, "s1", "acme");
    page(2, "s1", "games");
    expect(requests.summaryOf(1)?.workspace.id).toBe("acme");
    expect(requests.summaryOf(2)?.workspace.id).toBe("games");
    expect(requests.summaryOf(3)).toBeNull();
    requests.publish(1, "s1", null);
    expect(requests.summaryOf(1)).toBeNull();
    requests.forget(2);
    expect(requests.summaryOf(2)).toBeNull();
  });

  it("answers no when nobody published the workspace, the page does not listen, or went away", async () => {
    const { requests, page, alive } = setUp();
    await expect(requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" })).resolves.toMatchObject({
      ok: false,
    });
    page(1, "s1", "acme");
    requests.listen(1, "s1", false);
    await expect(requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" })).resolves.toMatchObject({
      ok: false,
    });
    requests.listen(1, "s1", true);
    alive.delete(1);
    await expect(requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("gives up after 20 seconds, and when the page goes away meanwhile", async () => {
    const { requests, page } = setUp();
    page(1, "s1", "acme");
    const late = requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" });
    vi.advanceTimersByTime(20_000);
    await expect(late).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("did not answer"),
      unanswered: true,
    });

    const pending = requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" });
    requests.forget(1);
    await expect(pending).resolves.toMatchObject({ ok: false, unanswered: true });
    // Its summary went with it.
    expect(requests.summaries()).toEqual([]);
  });

  it("tells a page's own refusal from no answer, and a page cannot pass its refusal off as no answer", async () => {
    const { requests, page, lastTo } = setUp();
    page(1, "s1", "acme");
    expect(await requests.toWorkspace("s1", "other", { kind: "revoke-token", token: "t" })).toMatchObject({
      unanswered: true,
    });
    const answer = requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" });
    requests.answer(1, { id: lastTo(1)?.id, outcome: { ok: false, message: "Refused.", unanswered: true } });
    expect(await answer).toEqual({ ok: false, message: "Refused." });
  });

  it("holds a page's answer to the outcome's shape", async () => {
    const { requests, page, lastTo } = setUp();
    page(1, "s1", "acme");
    const answer = requests.toWorkspace("s1", "acme", { kind: "revoke-token", token: "t" });
    requests.answer(1, { id: lastTo(1)?.id, outcome: { ok: "sure" } });
    await expect(answer).resolves.toMatchObject({ ok: false });
  });

  it("sends a notification's request only to the page that sent it", async () => {
    const { requests, page, lastTo, sent } = setUp();
    page(1, "s1", "acme");
    page(2, "s1", "acme");
    const answer = requests.toPage(1, "s1", { kind: "action", request: "read:i1" });
    expect(sent.get(2)).toBeUndefined();
    requests.answer(1, { id: lastTo(1)?.id, outcome: { ok: true } });
    await expect(answer).resolves.toEqual({ ok: true });
    // A page of another server is not that page.
    await expect(requests.toPage(1, "s2", { kind: "action", request: "read:i1" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("lets the panel's action go only to the server and workspace that offered it", async () => {
    const { requests, page, lastTo, sent } = setUp();
    page(1, "s1", "acme", ["pick:d1:o1"]);
    page(2, "s2", "acme", ["pick:d9:o9"]);
    // Server 2's request named with server 1: refused, and nothing is sent anywhere.
    await expect(requests.act("s1", "acme", { request: "pick:d9:o9" })).resolves.toMatchObject({ ok: false });
    expect(sent.get(1)).toBeUndefined();
    expect(sent.get(2)).toBeUndefined();
    const answer = requests.act("s1", "acme", { request: "pick:d1:o1" });
    expect(lastTo(1)?.request).toEqual({ kind: "action", request: "pick:d1:o1" });
    expect(sent.get(2)).toBeUndefined();
    requests.answer(1, { id: lastTo(1)?.id, outcome: { ok: true } });
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("lists one summary per workspace, the newest publisher's, and says when one changes", () => {
    const { requests, page, changes } = setUp();
    page(1, "s1", "acme");
    page(2, "s1", "acme");
    page(3, "s2", "acme");
    expect(requests.summaries().map((s) => [s.serverId, s.summary.workspace.id])).toEqual([
      ["s1", "acme"],
      ["s2", "acme"],
    ]);
    const before = changes();
    requests.publish(2, "s1", null);
    expect(changes()).toBe(before + 1);
    expect(requests.summaries()).toHaveLength(2);
    requests.forget(1);
    expect(requests.summaries().map((s) => s.serverId)).toEqual(["s2"]);
  });
});

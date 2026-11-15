// Keeping the store current (lib/sync.ts): the starting copy, the live
// stream, and the tabs that share one stream. The server, the stream and
// what the browser puts between tabs are fakes on the test's clock.
//
// A tab of the app is the app's modules loaded afresh (`openTab`): its own
// store, its own sync. Tabs opened in one test share the fake channel, locks
// and server, as tabs of one browser do. Where a test must say exactly what
// the leading tab says, or have it say nothing, the test plays that tab
// itself (`lead`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStream, EventStreamHandlers } from "@/lib/event-stream";
import type { BootstrapData } from "@/lib/store";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { type FakeTabs, fakeTabs } from "@/test/fake-tabs";

const W = "/api/v1/w/acme";
const OPEN_PART = `${W}/bootstrap?part=open`;
const REST_PART = `${W}/bootstrap?part=rest`;
const WHOLE = `${W}/bootstrap`;
const WHO_AM_I = "/api/v1/auth/me";
const CHANGES = `${W}/changes?events=1`;
const MISSED = /\/events\?after=\d+&limit=2000$/;
/** The name the tabs of the workspace share, for their channel and for the leader's lock. */
const SHARED = "quadit-tabs-acme";

const me = { user_id: "u1", role: "member" } as Member;
const copy = (over: Partial<BootstrapData> = {}): BootstrapData => ({
  seq: 10,
  me,
  user: { id: "u1" } as User,
  workspace: { id: "w", slug: "acme" } as Workspace,
  tasks: [{ id: "t1", title: "a" }],
  ...over,
});

const retitle = (seq: number, id: string, to: string): FeedEvent => ({
  seq,
  at: seq,
  actor_id: "u2",
  change_id: `c${seq}`,
  type: "task.updated",
  entity_type: "task",
  entity_id: id,
  scope_type: "",
  scope_id: "",
  data: { changes: { title: { from: "", to } } },
});

/** The live stream as the test's server: the test opens it, sends on it and ends it. */
class FakeStream implements EventStream {
  /** Closed by the app. As with the real stream, nothing is heard after that. */
  closed = false;
  private ended = false;

  constructor(
    readonly url: string,
    private handlers: EventStreamHandlers,
  ) {}

  close() {
    this.closed = true;
  }

  open() {
    if (!this.closed && !this.ended) this.handlers.onOpen();
  }
  events(...events: FeedEvent[]) {
    if (!this.closed && !this.ended) this.handlers.onEvents(events);
  }
  signal(name: string) {
    if (!this.closed && !this.ended) this.handlers.onSignal(name);
  }
  /** The stream ends by itself: dropped (no status), or refused by the server with one. */
  end(status: number | null = null) {
    if (this.closed || this.ended) return;
    this.ended = true;
    this.handlers.onClose(status);
  }
}

let server: FakeServer;
let tabs: FakeTabs;
let page: { window: EventTarget; document: EventTarget & { visibilityState: "visible" | "hidden" } };
/** The tabs a test opened, to close after it. */
let opened: { close(): void; clearOutbox(): Promise<void> }[] = [];

/** Lets everything that is due happen: answers arrive, messages and locks are delivered. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Loads the app's modules afresh, as a new tab does. `start` opens the workspace in it. */
async function openTab() {
  vi.resetModules();
  const streams: FakeStream[] = [];
  vi.doMock("@/lib/event-stream", () => ({
    openEventStream(url: string, handlers: EventStreamHandlers) {
      const stream = new FakeStream(url, handlers);
      streams.push(stream);
      return stream;
    },
  }));
  const store = await import("@/lib/store");
  const sync = await import("@/lib/sync");
  const { mutate, clearOutbox } = await import("@/lib/mutate");
  const { onUnauthorized } = await import("@/lib/api");
  const signedOut = vi.fn();
  onUnauthorized(signedOut);
  const tab = {
    /** Every stream the tab opened, oldest first. */
    streams,
    /** The stream it opened last. */
    get stream() {
      return streams.at(-1) as FakeStream;
    },
    state: store.getState,
    title: (id: string) => store.getState().collections.tasks[id]?.title,
    /** What the app says when the person may no longer see the workspace; null while they may. */
    lost() {
      const now = sync.availability("acme");
      return now.is === "lost" ? { slug: "acme", message: now.message } : null;
    },
    availability: () => sync.availability("acme"),
    signedOut,
    mutate,
    onEvents: store.onEvents,
    async start() {
      sync.startSync("acme");
      await settle();
    },
    /** The tab goes away. Closing a real tab lets go of the same things: the lock, the channel, the stream. */
    close: () => sync.stopSync(),
    clearOutbox,
  };
  opened.push(tab);
  return tab;
}

/** A tab that leads from the start, its stream open. */
async function openLeader() {
  const tab = await openTab();
  await tab.start();
  tab.stream.open();
  return tab;
}

type Said = { t: string } & Record<string, unknown>;

/**
 * The test as the tab that leads: it holds the leader's lock from now on,
 * says only what the test tells it to, and notes what it hears.
 */
function lead() {
  const channel = tabs.channel(SHARED);
  const heard: Said[] = [];
  // What the app's tabs say to each other travels inside lib/tab-share.ts's own envelope.
  channel.onmessage = (e) => {
    const wire = e.data as { is: string; msg: Said };
    if (wire.is === "say") heard.push(wire.msg);
  };
  const say = (msg: Said) => channel.postMessage({ is: "say", msg });
  const lock = { letGo: () => {}, lost: false };
  tabs.locks
    .request(SHARED, () => new Promise<void>((resolve) => (lock.letGo = resolve)))
    .catch(() => (lock.lost = true));
  return {
    heard,
    asks: () => heard.filter((msg) => msg.t === "hello").length,
    say,
    /** Passes events on as read from the stream; `from` is where the leader stood before them. */
    passOn: (from: number, ...events: FeedEvent[]) => say({ t: "ev", from, events }),
    /** Gives the lock up, as a closing tab does. */
    letGo: () => lock.letGo(),
    /** True once the lock was taken from it. */
    lostTheLock: () => lock.lost,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Every wait before a new try is as long as it can be: lib/api.ts shortens them at random.
  vi.spyOn(Math, "random").mockReturnValue(1);
  tabs = fakeTabs();
  server = fakeServer();
  page = {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), {
      visibilityState: "visible" as const,
      documentElement: { dataset: {} },
    }),
  };
  vi.stubGlobal("window", page.window);
  vi.stubGlobal("document", page.document);
  opened = [];
  server.get(OPEN_PART, copy());
  server.get(WHO_AM_I, { workspaces: [{ slug: "acme" }] });
  server.get(`${W}/me`, {});
});

afterEach(async () => {
  for (const tab of opened) {
    tab.close();
    await tab.clearOutbox();
  }
  await settle();
  const unexpected = server.unexpected;
  vi.doUnmock("@/lib/event-stream");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

const putAway = () => page.window.dispatchEvent(new Event("pagehide"));
const shownAgain = () => page.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
const comesOnline = () => page.window.dispatchEvent(new Event("online"));
function setVisibility(state: "visible" | "hidden") {
  page.document.visibilityState = state;
  page.document.dispatchEvent(new Event("visibilitychange"));
}

describe("the tabs of one workspace", () => {
  it("the first tab leads: it reads the stream from where its copy stands", async () => {
    const a = await openTab();
    await a.start();
    expect(a.streams).toHaveLength(1);
    expect(a.stream.url).toBe(`${W}/events/stream?after=10`);
    expect(a.state().stream).toBe("connecting");

    a.stream.open();
    expect(a.state().stream).toBe("live");
    a.stream.events(retitle(11, "t1", "b"));
    expect(a.title("t1")).toBe("b");
    expect(a.state().seq).toBe(11);
  });

  it("a second tab follows: it opens no stream, and is passed the stream's state and events by the leader", async () => {
    const a = await openLeader();
    const b = await openTab();
    await b.start();
    expect(b.streams).toHaveLength(0);
    expect(b.state().stream).toBe("live");

    a.stream.events(retitle(11, "t1", "b"));
    await settle();
    expect(b.title("t1")).toBe("b");
    expect(b.state().seq).toBe(11);

    a.stream.end();
    await settle();
    expect(b.state().stream).toBe("down");
  });

  it("shows a change made in one tab in the others at once, without moving their place in the stream", async () => {
    const a = await openLeader();
    const b = await openTab();
    await b.start();
    server.post(CHANGES, { results: [{ events: [retitle(11, "t1", "mine")] }] });
    await b.mutate({ type: "task.update", args: { id: "t1", title: "mine" } });
    await settle();
    expect(a.title("t1")).toBe("mine");
    expect(a.state().seq).toBe(10);
    expect(b.state().seq).toBe(10);
  });

  it("when the leader's tab closes, a follower takes the stream over from its own place", async () => {
    const a = await openLeader();
    const b = await openTab();
    await b.start();
    a.stream.events(retitle(11, "t1", "b"));
    await settle();

    a.close();
    await settle();
    expect(b.streams).toHaveLength(1);
    expect(b.stream.url).toBe(`${W}/events/stream?after=11`);
    b.stream.open();
    expect(b.state().stream).toBe("live");
  });

  it("a leader whose lock is taken closes its stream and stands in line for the lead again", async () => {
    const a = await openLeader();
    let letGo = () => {};
    void tabs.locks.request(SHARED, { steal: true }, () => new Promise<void>((resolve) => (letGo = resolve)));
    await settle();
    expect(a.streams).toHaveLength(1);
    expect(a.stream.closed).toBe(true);

    letGo();
    await settle();
    expect(a.streams).toHaveLength(2);
    expect(a.stream.closed).toBe(false);
  });

  it("a follower that missed events fetches them, holds what is passed on meanwhile, and applies all in order", async () => {
    const leader = lead();
    const b = await openTab();
    await b.start();
    const applied: number[] = [];
    b.onEvents((events) => applied.push(...events.map((ev) => ev.seq)));
    const missed = server.hold(`${W}/events?after=10&limit=2000`);

    // 11 and 12 never came: what follows them cannot be applied yet.
    leader.passOn(12, retitle(13, "t1", "thirteen"));
    await settle();
    leader.passOn(13, retitle(14, "t1", "fourteen"));
    await settle();
    expect(b.state().seq).toBe(10);
    expect(missed.calls).toHaveLength(1);

    missed.calls[0]?.answer({
      events: [retitle(11, "t1", "eleven"), retitle(12, "t1", "twelve")],
      seq: 12,
      more: false,
    });
    await settle();
    expect(applied).toEqual([11, 12, 13, 14]);
    expect(b.state().seq).toBe(14);
    expect(b.title("t1")).toBe("fourteen");
  });

  it("a follower told that the leader stands further on fetches what it missed", async () => {
    const leader = lead();
    const b = await openTab();
    await b.start();
    server.get(`${W}/events?after=10&limit=2000`, { events: [retitle(11, "t1", "eleven")], seq: 12, more: false });
    leader.say({ t: "state", state: "live", seq: 12 });
    await settle();
    expect(b.title("t1")).toBe("eleven");
    // The server's position counts even when the last events were not for this person.
    expect(b.state().seq).toBe(12);
    expect(b.state().stream).toBe("live");
  });

  it("a follower too far behind to replay fetches the whole copy instead", async () => {
    const leader = lead();
    const b = await openTab();
    await b.start();
    let page = 0;
    server.get(MISSED, () => ({ events: [retitle(11 + page, "t1", "old")], seq: 11 + page++, more: true }));
    server.get(WHOLE, copy({ seq: 50, tasks: [{ id: "t1", title: "current" }] }));
    leader.passOn(40, retitle(41, "t1", "late"));
    await settle();
    expect(server.count(MISSED)).toBe(3);
    expect(server.count(WHOLE)).toBe(1);
    expect(b.state().seq).toBe(50);
    expect(b.title("t1")).toBe("current");
  });

  it("a follower who sees only some projects fetches the whole copy instead of the events it missed", async () => {
    // GET /events leaves out what belongs to no project; the copy does not.
    const scoped = { ...me, scope: { projects: ["p1"] } } as Member;
    server.get(OPEN_PART, copy({ me: scoped }));
    server.get(WHOLE, copy({ me: scoped, seq: 20, tasks: [{ id: "t1", title: "current" }] }));
    const leader = lead();
    const b = await openTab();
    await b.start();

    leader.passOn(12, retitle(13, "t1", "thirteen"));
    await settle();
    expect(server.count(MISSED)).toBe(0);
    expect(server.count(WHOLE)).toBe(1);
    expect(b.state().seq).toBe(20);

    leader.passOn(20, retitle(21, "t1", "next"));
    await settle();
    expect(b.title("t1")).toBe("next");
  });

  it("a follower whose leader lets two asks in a row go unanswered takes the lead from it", async () => {
    const leader = lead();
    server.get(MISSED, { events: [], seq: 10, more: false });
    const b = await openTab();
    await b.start();
    await later(20_000);
    expect(b.streams).toHaveLength(0);
    expect(leader.lostTheLock()).toBe(false);

    await later(20_000);
    expect(leader.lostTheLock()).toBe(true);
    expect(b.streams).toHaveLength(1);
    expect(b.stream.url).toBe(`${W}/events/stream?after=10`);
  });

  it("a leader that answers is left alone", async () => {
    const a = await openLeader();
    const b = await openTab();
    await b.start();
    await later(120_000);
    expect(b.streams).toHaveLength(0);
    expect(a.streams).toHaveLength(1);
    expect(a.stream.closed).toBe(false);
  });

  it("a follower whose page is hidden does not count its asks, and asks at once when shown again", async () => {
    const leader = lead();
    const b = await openTab();
    await b.start();
    setVisibility("hidden");
    await later(120_000);
    expect(leader.lostTheLock()).toBe(false);
    expect(b.streams).toHaveLength(0);

    const asked = leader.asks();
    setVisibility("visible");
    await settle();
    expect(leader.asks()).toBe(asked + 1);
  });
});

describe("the connection", () => {
  it("reopens a dropped stream from the place applied, waiting longer each time, and says so meanwhile", async () => {
    const a = await openLeader();
    a.stream.events(retitle(11, "t1", "b"));
    a.stream.end();
    await settle();
    expect(a.state().stream).toBe("down");

    await later(999);
    expect(a.streams).toHaveLength(1);
    await later(1);
    expect(a.streams).toHaveLength(2);
    expect(a.stream.url).toBe(`${W}/events/stream?after=11`);

    a.stream.end();
    await later(1999);
    expect(a.streams).toHaveLength(2);
    await later(1);
    expect(a.streams).toHaveLength(3);

    // Open again: live, the copy kept, and the next drop waits the short time again.
    a.stream.open();
    expect(a.state().stream).toBe("live");
    expect(server.count(WHOLE)).toBe(0);
    a.stream.end();
    await later(1000);
    expect(a.streams).toHaveLength(4);
  });

  it("asks whether the person may still be here before reopening a stream the server refused", async () => {
    const a = await openLeader();
    a.stream.end(403);
    await settle();
    expect(a.state().stream).toBe("down");
    await later(999);
    expect(server.count(WHO_AM_I)).toBe(0);
    await later(1);
    expect(server.count(WHO_AM_I)).toBe(1);
    expect(server.count(`${W}/me`)).toBe(1);
    expect(a.streams).toHaveLength(2);
    expect(a.lost()).toBeNull();
  });

  it("leaves the workspace when the stream is refused because the person was suspended", async () => {
    const a = await openLeader();
    server.get(`${W}/me`, refuse(403, "suspended"));
    a.stream.end(403);
    await later(1000);
    expect(a.lost()).toEqual({ slug: "acme", message: "suspended" });
    expect(a.state().ready).toBe(false);
    expect(a.streams).toHaveLength(1);
  });

  it("keeps asking why a stream was refused while the server cannot be asked, then reopens it", async () => {
    const a = await openLeader();
    a.stream.end(403);
    server.down = true;
    await later(1000);
    expect(server.count(WHO_AM_I)).toBe(1);
    await later(1000);
    expect(server.count(WHO_AM_I)).toBe(2);
    expect(a.streams).toHaveLength(1);

    server.down = false;
    await later(2000);
    expect(a.streams).toHaveLength(2);
    expect(a.lost()).toBeNull();
  });

  it("does not ask again for a stream the server will not give this session (204)", async () => {
    const a = await openTab();
    await a.start();
    a.stream.end(204);
    await later(120_000);
    expect(a.streams).toHaveLength(1);
    expect(a.state().stream).toBe("connecting");
    expect(server.count(WHO_AM_I)).toBe(0);
  });

  it("fetches the whole copy again when the stream comes back after more than five minutes", async () => {
    const a = await openLeader();
    server.get(WHOLE, copy({ seq: 90, tasks: [{ id: "t1", title: "much later" }] }));
    a.stream.end();
    await later(1000);
    expect(a.streams).toHaveLength(2);

    await later(5 * 60_000);
    a.stream.open();
    await settle();
    expect(server.count(WHOLE)).toBe(1);
    expect(a.title("t1")).toBe("much later");
    expect(a.streams).toHaveLength(3);
    expect(a.stream.url).toBe(`${W}/events/stream?after=90`);
    a.stream.open();
    expect(a.state().stream).toBe("live");
  });

  it("opens the stream anew when the browser comes back online, in case the one held died silently", async () => {
    const a = await openLeader();
    a.stream.events(retitle(11, "t1", "b"));
    comesOnline();
    expect(a.streams).toHaveLength(2);
    expect(a.streams[0]?.closed).toBe(true);
    expect(a.stream.url).toBe(`${W}/events/stream?after=11`);
  });

  it("a follower asks the leader how the stream is doing when the browser comes back online", async () => {
    const leader = lead();
    const b = await openTab();
    await b.start();
    const asked = leader.asks();
    comesOnline();
    await settle();
    expect(leader.asks()).toBe(asked + 1);
    expect(b.streams).toHaveLength(0);
  });

  it("opens the stream anew when a change that could not be sent goes through: the server was away", async () => {
    const a = await openLeader();
    server.down = true;
    const sent = a.mutate({ type: "task.update", args: { id: "t1", title: "x" } });
    await settle();
    expect(a.state().offline).toBe(true);
    expect(a.streams).toHaveLength(1);

    server.down = false;
    server.post(CHANGES, { results: [] });
    await later(2000);
    await sent;
    expect(a.streams).toHaveLength(2);
    expect(a.streams[0]?.closed).toBe(true);
  });

  it("a follower whose change goes through after the server was away has the leader open the stream anew", async () => {
    const a = await openLeader();
    const b = await openTab();
    await b.start();
    server.down = true;
    const sent = b.mutate({ type: "task.update", args: { id: "t1", title: "x" } });
    await settle();
    server.down = false;
    server.post(CHANGES, { results: [] });
    await later(2000);
    await sent;
    await settle();
    expect(a.streams).toHaveLength(2);
    expect(b.streams).toHaveLength(0);
  });

  describe("when the server says to start over (reset)", () => {
    const before = copy({
      projects: [
        { id: "p1", key: "SVA" },
        { id: "p2", key: "OPS" },
      ],
    });
    const after = copy({ seq: 30, tasks: [], projects: [{ id: "p1", key: "SVA" }] });

    it("every tab fetches a fresh copy that keeps nothing of the old one, and the leader follows from it", async () => {
      server.get(OPEN_PART, before);
      const a = await openLeader();
      const b = await openTab();
      await b.start();

      server.get(OPEN_PART, after);
      a.stream.signal("reset");
      await settle();
      expect(a.streams[0]?.closed).toBe(true);
      for (const tab of [a, b]) {
        expect(tab.state().seq).toBe(30);
        expect(tab.title("t1")).toBeUndefined();
        // Only a copy that starts from nothing names the projects no longer seen.
        expect(tab.state().lostProjects).toEqual(["OPS"]);
      }
      expect(server.count(WHOLE)).toBe(0);
      expect(a.streams).toHaveLength(2);
      expect(a.stream.url).toBe(`${W}/events/stream?after=30`);
      expect(b.streams).toHaveLength(0);
    });

    it("keeps asking for the fresh copy while the server cannot be reached", async () => {
      server.get(OPEN_PART, before);
      const a = await openLeader();
      server.down = true;
      a.stream.signal("reset");
      await later(1000);
      expect(a.state().seq).toBe(10);
      expect(a.streams).toHaveLength(1);

      server.down = false;
      server.get(OPEN_PART, after);
      await later(2000);
      expect(a.state().seq).toBe(30);
      expect(a.stream.url).toBe(`${W}/events/stream?after=30`);
    });

    it("leaves the workspace when the fresh copy is refused", async () => {
      const a = await openLeader();
      server.get(OPEN_PART, refuse(403, "suspended"));
      a.stream.signal("reset");
      await settle();
      expect(a.lost()).toEqual({ slug: "acme", message: "suspended" });
      expect(a.state().ready).toBe(false);
    });

    it("a reason to start over that comes while a copy is on its way starts the asking over, and nothing is kept after all", async () => {
      server.get(OPEN_PART, before);
      const leader = lead();
      const b = await openTab();
      await b.start();

      // Too far behind to replay: a whole copy is asked for, which would keep what is on screen.
      server.get(MISSED, { events: [], seq: 10, more: true });
      const whole = server.hold(WHOLE);
      leader.passOn(40, retitle(41, "t1", "late"));
      await settle();
      expect(whole.calls).toHaveLength(1);

      // Then the server says to start over: the copy on its way may be from before that.
      const fresh = server.hold(OPEN_PART);
      leader.say({ t: "reset" });
      await settle();
      expect(whole.calls[0]?.aborted).toBe(true);
      expect(fresh.calls).toHaveLength(1);

      // And a second reason that by itself would keep the old copy: still nothing is kept.
      leader.say({ t: "state", state: "live", seq: 99 });
      await settle();
      leader.passOn(98, retitle(99, "t1", "later still"));
      await settle();
      expect(whole.calls).toHaveLength(1);
      fresh.calls.at(-1)?.answer(after);
      await settle();
      expect(b.state().seq).toBe(30);
      expect(b.state().lostProjects).toEqual(["OPS"]);
    });

    // Once a defect: opening the stream cancelled the wait to ask again, and
    // the tab went live on the copy it was told to throw away, with rows on
    // screen the person may no longer see.
    it("a follower still waiting for its fresh copy when the lead falls to it starts over all the same", async () => {
      server.get(OPEN_PART, before);
      const leader = lead();
      const b = await openTab();
      await b.start();

      server.down = true;
      leader.say({ t: "reset" });
      await settle();
      leader.letGo();
      await settle();
      // It leads now, but follows no stream from the copy it is about to throw away.
      expect(b.streams).toHaveLength(0);

      server.down = false;
      server.get(OPEN_PART, after);
      await later(15_000);
      expect(b.state().seq).toBe(30);
      expect(b.state().lostProjects).toEqual(["OPS"]);
      expect(b.streams).toHaveLength(1);
      expect(b.stream.url).toBe(`${W}/events/stream?after=30`);
    });
  });

  describe("when the server says to leave (gone)", () => {
    it("leaves the workspace if the person is no longer a member: the copy is emptied, in every tab", async () => {
      const a = await openLeader();
      const b = await openTab();
      await b.start();
      server.get(WHO_AM_I, { workspaces: [] });
      a.stream.signal("gone");
      await settle();
      for (const tab of [a, b]) {
        expect(tab.lost()).toEqual({ slug: "acme", message: "" });
        expect(tab.state()).toMatchObject({ ready: false, slug: "", me: null });
        expect(tab.state().collections.tasks).toEqual({});
      }
      expect(a.stream.closed).toBe(true);
      // Nothing of it is left running: the lead is free for another tab.
      expect(tabs.locks.isHeld(SHARED)).toBe(false);
    });

    it("says the server's own words when the person is still a member but suspended", async () => {
      const a = await openLeader();
      server.get(`${W}/me`, refuse(403, "you are suspended in this workspace"));
      a.stream.signal("gone");
      await settle();
      expect(a.lost()).toEqual({ slug: "acme", message: "you are suspended in this workspace" });
    });

    it("does nothing more when the person is signed out: the sign-in page takes over", async () => {
      const a = await openLeader();
      server.get(WHO_AM_I, refuse(401, "sign in"));
      a.stream.signal("gone");
      await later(60_000);
      expect(a.signedOut).toHaveBeenCalled();
      expect(a.lost()).toBeNull();
      expect(server.count(WHO_AM_I)).toBe(1);
      expect(a.streams).toHaveLength(1);
    });

    it("keeps asking where the person stands while the server cannot be asked", async () => {
      const a = await openLeader();
      server.down = true;
      a.stream.signal("gone");
      await settle();
      expect(server.count(WHO_AM_I)).toBe(1);
      await later(1000);
      expect(server.count(WHO_AM_I)).toBe(2);
      expect(a.lost()).toBeNull();

      server.down = false;
      server.get(WHO_AM_I, { workspaces: [] });
      await later(2000);
      expect(a.lost()).toEqual({ slug: "acme", message: "" });
    });

    it("starts over from a fresh copy if the person was let back in meanwhile", async () => {
      const a = await openLeader();
      server.get(OPEN_PART, copy({ seq: 40 }));
      a.stream.signal("gone");
      await settle();
      expect(a.lost()).toBeNull();
      expect(a.state().seq).toBe(40);
      expect(a.streams).toHaveLength(2);
      expect(a.stream.url).toBe(`${W}/events/stream?after=40`);
    });
  });

  describe("a page put away for Back and Forward", () => {
    it("lets go of the stream and the lead, and when shown again fetches what it missed and stands in line", async () => {
      const a = await openLeader();
      let nextLeads = false;
      let letGo = () => {};
      void tabs.locks.request(SHARED, () => {
        nextLeads = true;
        return new Promise<void>((resolve) => (letGo = resolve));
      });

      putAway();
      await settle();
      expect(a.stream.closed).toBe(true);
      expect(nextLeads).toBe(true);

      server.get(`${W}/events?after=10&limit=2000`, { events: [retitle(11, "t1", "b")], seq: 11, more: false });
      shownAgain();
      await settle();
      expect(a.title("t1")).toBe("b");
      expect(a.streams).toHaveLength(1);

      letGo();
      await settle();
      expect(a.streams).toHaveLength(2);
      expect(a.stream.url).toBe(`${W}/events/stream?after=11`);
    });

    it("opens nothing if it was put away before its copy arrived; shown again, it takes its place among the tabs", async () => {
      const first = server.hold(OPEN_PART);
      server.get(MISSED, { events: [], seq: 10, more: false });
      const a = await openTab();
      const started = a.start();
      await settle();
      putAway();
      first.calls[0]?.answer(copy());
      await started;
      await later(60_000);
      expect(a.state().ready).toBe(true);
      expect(a.streams).toHaveLength(0);
      expect(tabs.locks.isHeld(SHARED)).toBe(false);

      shownAgain();
      await settle();
      expect(a.streams).toHaveLength(1);
      expect(a.stream.url).toBe(`${W}/events/stream?after=10`);
    });

    it("put away and shown again before its copy arrived, it joins the tabs when the copy does", async () => {
      const first = server.hold(OPEN_PART);
      const a = await openTab();
      await a.start();
      putAway();
      shownAgain();
      await settle();
      first.calls[0]?.answer(copy());
      await settle();
      expect(a.streams).toHaveLength(1);
    });

    it("where tabs cannot share, lets go of its own stream and opens it again when shown", async () => {
      tabs.setSharing(false);
      server.get(MISSED, { events: [], seq: 10, more: false });
      const a = await openTab();
      await a.start();
      a.stream.open();

      putAway();
      expect(a.stream.closed).toBe(true);
      await later(60_000);
      expect(a.streams).toHaveLength(1);

      shownAgain();
      await settle();
      expect(a.streams).toHaveLength(2);
      expect(a.stream.url).toBe(`${W}/events/stream?after=10`);
      a.stream.open();
      expect(a.state().stream).toBe("live");
    });
  });
});

describe("opening the workspace", () => {
  it("says it is loading until the copy arrives, then that it is ready", async () => {
    const first = server.hold(OPEN_PART);
    const a = await openTab();
    await a.start();
    expect(a.availability()).toEqual({ is: "loading" });
    first.calls[0]?.answer(copy());
    await settle();
    expect(a.availability()).toEqual({ is: "ready" });
    expect(a.streams).toHaveLength(1);
  });

  it("while the server cannot be reached says so and keeps asking, with longer waits, until the copy comes", async () => {
    server.down = true;
    const a = await openTab();
    await a.start();
    expect(a.availability()).toEqual({ is: "offline" });
    expect(a.state().stream).toBe("down");
    await later(999);
    expect(server.count(OPEN_PART)).toBe(1);
    await later(1);
    expect(server.count(OPEN_PART)).toBe(2);
    await later(2000);
    expect(server.count(OPEN_PART)).toBe(3);
    expect(a.availability()).toEqual({ is: "offline" });
    expect(a.streams).toHaveLength(0);

    server.down = false;
    await later(4000);
    expect(a.availability()).toEqual({ is: "ready" });
    expect(a.state().stream).toBe("connecting");
    expect(a.streams).toHaveLength(1);
  });

  it("says why when the server will not give the copy, and does not ask again", async () => {
    const reasons: [unknown, unknown][] = [
      [refuse(404, "no such workspace"), { is: "refused", message: "no such workspace" }],
      [refuse(403, "your membership is suspended"), { is: "refused", message: "your membership is suspended" }],
      [refuse(403, "set it up first", "second_step_required"), { is: "second-step-needed" }],
      [refuse(500, "the database is busy"), { is: "failed", message: "the database is busy" }],
    ];
    for (const [answer, availability] of reasons) {
      server.get(OPEN_PART, answer);
      const a = await openTab();
      await a.start();
      expect(a.availability()).toEqual(availability);
      const asked = server.count(OPEN_PART);
      await later(60_000);
      expect(server.count(OPEN_PART)).toBe(asked);
      expect(a.streams).toHaveLength(0);
      expect(tabs.locks.isHeld(SHARED)).toBe(false);
    }
  });

  it("says nothing when the session has ended: the sign-in page takes over", async () => {
    server.get(OPEN_PART, refuse(401, "sign in"));
    const a = await openTab();
    await a.start();
    await later(60_000);
    expect(a.signedOut).toHaveBeenCalled();
    expect(a.availability()).toEqual({ is: "loading" });
    expect(server.count(OPEN_PART)).toBe(1);
  });

  it("starts over when opened again, and nothing of the try before arrives late", async () => {
    const first = server.hold(OPEN_PART);
    const a = await openTab();
    await a.start();
    await a.start();
    expect(first.calls).toHaveLength(2);
    expect(first.calls[0]?.aborted).toBe(true);
    first.calls[0]?.answer(copy({ seq: 5 }));
    await settle();
    expect(a.availability()).toEqual({ is: "loading" });

    first.calls[1]?.answer(copy({ seq: 10 }));
    await settle();
    expect(a.availability()).toEqual({ is: "ready" });
    expect(a.state().seq).toBe(10);
    expect(a.streams).toHaveLength(1);
  });

  it("stops asking when it is stopped", async () => {
    server.down = true;
    const a = await openTab();
    await a.start();
    a.close();
    await later(60_000);
    expect(server.count(OPEN_PART)).toBe(1);
  });
});

describe("the starting copy", () => {
  const openPart = copy({ part: "open", rest: 1 });

  it("shows the open work first and merges the finished work in when it lands", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    const a = await openTab();
    await a.start();
    expect(a.state()).toMatchObject({ ready: true, restLoaded: false });
    expect(a.streams).toHaveLength(1);

    rest.calls[0]?.answer({ seq: 10, tasks: [{ id: "t9", title: "done long ago" }] });
    await settle();
    expect(a.state().restLoaded).toBe(true);
    expect(a.title("t9")).toBe("done long ago");
    expect(a.title("t1")).toBe("a");
  });

  it("fetches no second part when the first says nothing was left out", async () => {
    server.get(OPEN_PART, copy({ part: "open", rest: 0 }));
    const a = await openTab();
    await a.start();
    expect(a.state().restLoaded).toBe(true);
    expect(server.count(REST_PART)).toBe(0);
  });

  it("applies again, over the finished work, what happened while it was on its way", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    const a = await openLeader();
    a.stream.events(retitle(11, "t9", "renamed since"));
    rest.calls[0]?.answer({ seq: 10, tasks: [{ id: "t9", title: "old name", updated_seq: 4 }] });
    await settle();
    expect(a.title("t9")).toBe("renamed since");
  });

  it("fetches one by one the tasks that events named and that came in neither part", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    server.get(`${W}/tasks/t7?raw=1`, { task: { id: "t7", title: "reopened in between" } });
    const a = await openLeader();
    a.stream.events(retitle(11, "t7", "reopened in between"));
    rest.calls[0]?.answer({ seq: 10, tasks: [] });
    await settle();
    expect(a.title("t7")).toBe("reopened in between");
  });

  it("keeps asking for the finished work while the server cannot be reached", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    const a = await openTab();
    await a.start();
    rest.calls[0]?.fail();
    await later(999);
    expect(rest.calls).toHaveLength(1);
    await later(1);
    expect(rest.calls).toHaveLength(2);

    rest.calls[1]?.answer({ seq: 10, tasks: [{ id: "t9", title: "done" }] });
    await settle();
    expect(a.state().restLoaded).toBe(true);
  });

  it("gives the finished work up when the server refuses it", async () => {
    server.get(OPEN_PART, openPart);
    server.get(REST_PART, refuse(403, "no"));
    const a = await openTab();
    await a.start();
    await later(120_000);
    expect(server.count(REST_PART)).toBe(1);
    expect(a.state().restLoaded).toBe(false);
  });

  it("drops a second part that answers late, for a copy that has been replaced since", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    const a = await openLeader();

    server.get(OPEN_PART, copy({ part: "open", rest: 1, seq: 30, tasks: [] }));
    a.stream.signal("reset");
    await settle();
    expect(a.state().seq).toBe(30);
    expect(rest.calls).toHaveLength(2);

    rest.calls[0]?.answer({ seq: 10, tasks: [{ id: "t9", title: "of the copy before" }] });
    await settle();
    expect(a.title("t9")).toBeUndefined();
    expect(a.state().restLoaded).toBe(false);

    rest.calls[1]?.answer({ seq: 30, tasks: [{ id: "t8", title: "of this copy" }] });
    await settle();
    expect(a.title("t8")).toBe("of this copy");
    expect(a.title("t9")).toBeUndefined();
    expect(a.state().restLoaded).toBe(true);
  });

  it("fetches the whole copy again when too much happened meanwhile to patch the second part", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    server.get(WHOLE, copy({ seq: 30_000, tasks: [{ id: "t1", title: "whole" }] }));
    const a = await openLeader();
    const flood: FeedEvent[] = [];
    for (let seq = 11; seq <= 20_011; seq++) flood.push(retitle(seq, "t1", "busy"));
    a.stream.events(...flood);

    rest.calls[0]?.answer({ seq: 10, tasks: [{ id: "t9", title: "not worth patching" }] });
    await settle();
    expect(server.count(WHOLE)).toBe(1);
    expect(a.state().seq).toBe(30_000);
    expect(a.state().restLoaded).toBe(true);
    expect(a.title("t1")).toBe("whole");
    expect(a.title("t9")).toBeUndefined();
  });

  it("patches the second part when what happened meanwhile is just within what is held", async () => {
    server.get(OPEN_PART, openPart);
    const rest = server.hold(REST_PART);
    const a = await openLeader();
    const many: FeedEvent[] = [];
    for (let seq = 11; seq <= 20_010; seq++) many.push(retitle(seq, "t9", `title ${seq}`));
    a.stream.events(...many);

    rest.calls[0]?.answer({ seq: 10, tasks: [{ id: "t9", title: "old", updated_seq: 3 }] });
    await settle();
    expect(server.count(WHOLE)).toBe(0);
    expect(a.title("t9")).toBe("title 20010");
  });
});

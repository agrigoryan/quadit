// One lead among the tabs (lib/tab-share.ts), on a fake BroadcastChannel and
// fake locks. Each `tab()` joins as a tab of its own; where a test needs a
// leader that says nothing, the test holds the lock itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, type TabShare } from "@/lib/tab-share";
import { type FakeTabs, fakeTabs } from "@/test/fake-tabs";

const NAME = "things";

let tabs: FakeTabs;
let joined: TabShare<string>[] = [];

/** Joins as one more tab, noting what it is told. */
function tab() {
  const told = { leads: false, led: 0, followed: 0, heard: [] as string[] };
  const share = join<string>(NAME, {
    onLead() {
      told.leads = true;
      told.led++;
    },
    onFollow() {
      told.leads = false;
      told.followed++;
    },
    onMessage: (msg) => told.heard.push(msg),
  });
  joined.push(share);
  return Object.assign(told, share);
}

/** The test holds the lead as a tab that never answers. */
function silentLeader() {
  const lock = { letGo: () => {}, taken: false };
  tabs.locks
    .request(NAME, () => new Promise<void>((resolve) => (lock.letGo = resolve)))
    .catch(() => (lock.taken = true));
  return lock;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const setVisibility = (state: "visible" | "hidden") => vi.stubGlobal("document", { visibilityState: state });

beforeEach(() => {
  vi.useFakeTimers();
  tabs = fakeTabs();
  joined = [];
});

afterEach(() => {
  for (const share of joined) share.leave();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("join", () => {
  it("the first tab comes to lead, after join has returned; the ones after it do not", async () => {
    const a = tab();
    expect(a.leads).toBe(false);
    await settle();
    const b = tab();
    await settle();
    expect(a).toMatchObject({ leads: true, led: 1 });
    expect(b).toMatchObject({ leads: false, led: 0 });
  });

  it("what a tab says is heard by every other tab, not by itself", async () => {
    const [a, b, c] = [tab(), tab(), tab()];
    await settle();
    b.post("from b");
    a.post("from a");
    await settle();
    expect(a.heard).toEqual(["from b"]);
    expect(b.heard).toEqual(["from a"]);
    expect(c.heard).toEqual(["from b", "from a"]);
  });

  it("drops what cannot be said without an error", async () => {
    const a = join<unknown>(NAME, { onLead() {}, onFollow() {}, onMessage() {} });
    joined.push(a as TabShare<string>);
    expect(() => a.post(() => {})).not.toThrow();
  });

  it("when the leader leaves, the tab next in line leads", async () => {
    const [a, b, c] = [tab(), tab(), tab()];
    await settle();
    a.leave();
    await settle();
    expect(b.leads).toBe(true);
    expect(c.leads).toBe(false);
    // Leaving is not following: nothing more is said to the tab that left.
    expect(a.followed).toBe(0);
    b.post("to those still here");
    await settle();
    expect(a.heard).toEqual([]);
  });

  it("a follower takes the lead from a leader that lets two asks in a row go unanswered", async () => {
    const leader = silentLeader();
    const b = tab();
    await later(39_999);
    expect(b.leads).toBe(false);
    expect(leader.taken).toBe(false);
    await later(1);
    expect(leader.taken).toBe(true);
    expect(b.leads).toBe(true);
  });

  it("a leader that answers keeps the lead", async () => {
    const [a, b] = [tab(), tab()];
    await later(10 * 60_000);
    expect(a).toMatchObject({ leads: true, followed: 0 });
    expect(b.leads).toBe(false);
  });

  it("a follower whose page is hidden asks nothing, so takes nothing", async () => {
    const leader = silentLeader();
    const b = tab();
    await settle();
    setVisibility("hidden");
    await later(10 * 60_000);
    expect(leader.taken).toBe(false);
    setVisibility("visible");
    await later(40_000);
    expect(leader.taken).toBe(true);
    expect(b.leads).toBe(true);
  });

  it("a leader whose lock is taken is told to follow, and leads again when its turn comes", async () => {
    const a = tab();
    await settle();
    let letGo = () => {};
    void tabs.locks.request(NAME, { steal: true }, () => new Promise<void>((resolve) => (letGo = resolve)));
    await settle();
    expect(a).toMatchObject({ leads: false, followed: 1 });
    letGo();
    await settle();
    expect(a).toMatchObject({ leads: true, led: 2 });
  });
});

describe("park", () => {
  it("gives the lead up to the next tab and tells the tab so; unparked, it waits its turn", async () => {
    const [a, b] = [tab(), tab()];
    await settle();
    a.park();
    expect(a).toMatchObject({ leads: false, followed: 1 });
    await settle();
    expect(b.leads).toBe(true);

    a.unpark();
    await settle();
    expect(a.leads).toBe(false);
    b.leave();
    await settle();
    expect(a).toMatchObject({ leads: true, led: 2 });
  });

  it("a parked follower is not given the lead, does not take it, and still hears", async () => {
    const leader = silentLeader();
    const b = tab();
    const c = tab();
    await settle();
    b.park();
    c.park();
    await later(10 * 60_000);
    expect(leader.taken).toBe(false);
    leader.letGo();
    await settle();
    expect(b.leads).toBe(false);
    expect(tabs.locks.isHeld(NAME)).toBe(false);
    expect(b.followed).toBe(0);

    c.post("still here");
    await settle();
    expect(b.heard).toEqual(["still here"]);
    b.unpark();
    await settle();
    expect(b.leads).toBe(true);
  });
});

describe("where tabs cannot share", () => {
  beforeEach(() => tabs.setSharing(false));

  it("every tab leads alone, after join has returned, and what it says reaches nobody", async () => {
    const a = tab();
    const b = tab();
    expect(a.leads).toBe(false);
    await settle();
    expect(a.leads).toBe(true);
    expect(b.leads).toBe(true);
    a.post("anyone?");
    await settle();
    expect(b.heard).toEqual([]);
  });

  it("a parked tab does not lead until it is unparked", async () => {
    const a = tab();
    a.park();
    await settle();
    expect(a.leads).toBe(false);
    a.unpark();
    await settle();
    expect(a).toMatchObject({ leads: true, led: 1 });
    a.park();
    expect(a).toMatchObject({ leads: false, followed: 1 });
  });

  it("a tab that left before it came to lead is told nothing", async () => {
    const a = tab();
    a.leave();
    await settle();
    expect(a.led).toBe(0);
  });
});

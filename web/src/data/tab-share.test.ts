// One lead among the tabs (data/tab-share.ts), on a fake BroadcastChannel and
// fake locks. Each `tab()` joins as a tab of its own; where a test needs a
// leader that says nothing, the test holds the lock itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, type TabShare } from "@/data/tab-share";
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
    joined.push(a);
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

  it("a parked follower is not given the lead, does not take it, and hears nothing until unparked", async () => {
    const leader = silentLeader();
    const b = tab();
    const c = tab();
    await settle();
    b.park();
    c.park();
    // Nor does it keep a place in line: the page may be frozen when its turn comes.
    expect((await tabs.locks.query()).pending).toEqual([]);
    await later(10 * 60_000);
    expect(leader.taken).toBe(false);
    leader.letGo();
    await settle();
    expect(b.leads).toBe(false);
    expect(tabs.locks.isHeld(NAME)).toBe(false);
    expect(b.followed).toBe(0);

    // A browser throws a kept page out of its cache when a message comes for it: the channel is closed meanwhile.
    const other = tabs.channel(NAME);
    other.postMessage({ is: "say", msg: "while away" });
    await settle();
    expect(b.heard).toEqual([]);
    b.unpark();
    await settle();
    expect(b.leads).toBe(true);
    other.postMessage({ is: "say", msg: "back" });
    await settle();
    expect(b.heard).toEqual(["back"]);
  });

  it("a tab that has left stays gone: unparked afterwards it neither hears nor leads", async () => {
    const [a, b] = [tab(), tab()];
    await settle();
    b.park();
    b.leave();
    b.unpark();
    a.post("to nobody");
    a.leave();
    await later(30_000);
    expect(b.heard).toEqual([]);
    expect(b.leads).toBe(false);
  });

  it("a parked tab says nothing, and once unparked is heard again", async () => {
    const [a, b] = [tab(), tab()];
    await settle();
    b.park();
    b.post("while away");
    await settle();
    expect(a.heard).toEqual([]);
    b.unpark();
    b.post("back");
    await settle();
    expect(a.heard).toEqual(["back"]);
  });

  it("a tab parked just as the lead falls to it does not take it", async () => {
    const a = tab();
    a.park();
    await settle();
    expect(a).toMatchObject({ leads: false, led: 0 });
    expect(tabs.locks.isHeld(NAME)).toBe(false);
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

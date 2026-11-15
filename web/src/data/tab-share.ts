// One lead among the tabs that have the same thing open.
//
// Tabs that join under one name can say things to each other, and exactly
// one of them leads at a time (data/sync.ts has the leader hold the live
// stream for all of them). This file hides how: the leader is whoever holds
// a Web Lock of that name, and the tabs talk on a BroadcastChannel. When the
// leader's tab closes, the browser gives the lock to the next tab in line.
// A leader can also be there and do nothing (a frozen tab), so every
// follower asks it now and then whether it is still there, and takes the
// lock from one that lets two asks in a row go by.
//
// Where the browser has no Web Locks or no BroadcastChannel, a tab cannot
// share: it leads alone from the start and what it says reaches nobody.

/** How often a follower asks the leader whether it is still there. */
const PING_MS = 20_000;
/** Unanswered asks in a row before a follower takes the lead over. */
const PING_MISSES = 2;

export interface TabHandlers<M> {
  /** This tab leads from now on: no other tab does. */
  onLead(): void;
  /** This tab led and no longer does: another tab took the lead from it, or it was parked. */
  onFollow(): void;
  /** Another tab said this. */
  onMessage(msg: M): void;
}

export interface TabShare<M> {
  /**
   * Says `msg` to every other tab that joined under the same name. Best
   * effort: a message that cannot be sent is dropped without an error.
   */
  post(msg: M): void;
  /**
   * Takes the tab out of the running while its page is put away (kept by the
   * browser for Back and Forward): it gives the lead up if it has it, and is
   * not given it, so that a page nobody sees never holds what the others
   * rely on. It still hears what is said.
   */
  park(): void;
  /** Undoes park(): the tab stands for the lead again. */
  unpark(): void;
  /** Leaves for good, giving the lead up. No handler is called after this. */
  leave(): void;
}

/** What goes over the channel: the tabs' own messages, and this file's asking and answering. */
type Wire<M> = { is: "say"; msg: M } | { is: "ping" } | { is: "pong" };

const canShare = () =>
  typeof BroadcastChannel !== "undefined" && typeof navigator !== "undefined" && "locks" in navigator;

/**
 * Joins the tabs that have `name` open. `onLead` is called when this tab
 * comes to lead: soon after joining if no other tab does, or later, when the
 * leader's tab closes or stops answering.
 */
export function join<M>(name: string, handlers: TabHandlers<M>): TabShare<M> {
  if (!canShare()) return alone(handlers);

  const channel = new BroadcastChannel(name);
  let leads = false;
  let parked = false;
  let left = false;
  /** Lets go of the leader's lock, while this tab holds it. */
  let release: (() => void) | null = null;
  /** Gives up the place in line for the lock. */
  let lockWait: AbortController | null = null;
  /** An ask the leader has not answered yet, and how many went unanswered in a row. */
  let asked = false;
  let misses = 0;

  function send(wire: Wire<M>) {
    try {
      channel.postMessage(wire);
    } catch {
      // A closed channel, or a message that cannot be copied.
    }
  }

  function ask() {
    asked = true;
    send({ is: "ping" });
  }

  /**
   * Asks for the leader's lock. It is granted when no other tab holds it:
   * at once for the first tab, or when the leader's tab closes. With `take`
   * it is taken from a leader that stopped answering.
   */
  function standForLead(take: boolean) {
    lockWait?.abort();
    const wait = new AbortController();
    lockWait = wait;
    const granted = () => {
      if (left || parked || leads) return undefined;
      // The lock is held for as long as this promise is pending.
      return new Promise<void>((resolve) => {
        release = resolve;
        leads = true;
        handlers.onLead();
      });
    };
    // "steal" and "signal" cannot be given together.
    const asking = take
      ? navigator.locks.request(name, { steal: true }, granted)
      : navigator.locks.request(name, { signal: wait.signal }, granted);
    asking.catch(() => {
      // Either this tab stopped waiting, or another tab took the lock from it.
      if (left || !leads || lockWait !== wait) return;
      leads = false;
      release = null;
      handlers.onFollow();
      ask();
      standForLead(false);
    });
  }

  channel.onmessage = (e) => {
    const wire = e.data as Wire<M>;
    if (wire.is === "say") handlers.onMessage(wire.msg);
    else if (wire.is === "ping" && leads) send({ is: "pong" });
    else if (wire.is === "pong") {
      asked = false;
      misses = 0;
    }
  };

  const pinging = setInterval(() => {
    if (leads || parked) return;
    // A page in the background is slowed down by the browser: it would miss answers that came.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (asked && ++misses >= PING_MISSES) {
      misses = 0;
      asked = false;
      standForLead(true);
      return;
    }
    ask();
  }, PING_MS);

  ask();
  standForLead(false);

  return {
    post: (msg) => send({ is: "say", msg }),
    park() {
      parked = true;
      lockWait?.abort();
      lockWait = null;
      release?.();
      release = null;
      if (!leads) return;
      leads = false;
      handlers.onFollow();
    },
    unpark() {
      if (!parked) return;
      parked = false;
      ask();
      standForLead(false);
    },
    leave() {
      left = true;
      clearInterval(pinging);
      lockWait?.abort();
      release?.();
      channel.close();
    },
  };
}

/** The tab where tabs cannot share: it leads whenever it is not parked, and talks to nobody. */
function alone<M>(handlers: TabHandlers<M>): TabShare<M> {
  let leads = false;
  let parked = false;
  let left = false;
  // Not inside the call that asked: join() and unpark() return first, as they do where the lock is asked for.
  const lead = () =>
    queueMicrotask(() => {
      if (left || parked || leads) return;
      leads = true;
      handlers.onLead();
    });
  lead();
  return {
    post() {},
    park() {
      parked = true;
      if (!leads) return;
      leads = false;
      handlers.onFollow();
    },
    unpark() {
      if (!parked) return;
      parked = false;
      lead();
    },
    leave() {
      left = true;
    },
  };
}

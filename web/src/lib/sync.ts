// Keeps the store current: a starting copy, then the live stream.
//
// The starting copy comes in two parts. The open work is fetched first and
// the app shows; the finished work (done, canceled and archived tasks) is
// fetched behind it and merged in when it lands (store.restLoaded says when).
//
// All tabs of one workspace share one live connection. The tabs pick a
// leader with a Web Lock; the leader holds the stream (lib/event-stream.ts)
// and passes each event, and the state of the stream, to the others on a
// BroadcastChannel.
// The others (followers) apply what they are passed exactly as if they had
// read the stream themselves. When the leader's tab closes the lock goes to
// another tab, which opens the stream from its own position. A follower
// that notices it missed something asks the server for the events after its
// position. Where the browser has no Web Locks or BroadcastChannel, every
// tab holds its own stream, as before.
//
// If the stream drops it is reopened from the last position applied; after a
// long gap, or when the server says "reset" (the person's role or projects
// changed), the whole copy is fetched again. When the server says "gone", or
// refuses the workspace on reconnect, the copy is emptied and `useAccess`
// says so; the shell then shows the way out.

import { create } from "zustand";
import { api, ApiError, noteReachable, workspacePath } from "@/lib/api";
import { type EventStream, openEventStream } from "@/lib/event-stream";
import { restoreQueue } from "@/lib/mutate";
import {
  applyEvents,
  type BootstrapData,
  clearStore,
  getState,
  loadBootstrap,
  mergeRest,
  mergeRows,
  onOwnEvents,
  type RestData,
  type StreamState,
  useStore,
} from "@/lib/store";
import type { FeedEvent, Task } from "@/lib/types";

/** Past this long without the stream, start from a fresh copy instead of replaying. */
const LONG_GAP_MS = 5 * 60_000;
/** How often a follower asks the leader whether it is still there. */
const PING_MS = 20_000;
/** Unanswered asks in a row before a follower takes the connection over. */
const PING_MISSES = 2;
/** A follower this many pages of events behind fetches a fresh copy instead. */
const CATCH_UP_PAGES = 3;

const backoff = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 4), 15_000);

/** Why the workspace on screen had to be left. */
export interface LostAccess {
  slug: string;
  /** The server's words for it, when it gave any. */
  message: string;
}

/**
 * Set when the person may no longer see the workspace they had open: they
 * were removed or suspended. (Someone signed out goes to the sign-in page
 * through api.onUnauthorized instead.) The store is already empty by then.
 */
export const useAccess = create<{ lost: LostAccess | null }>(() => ({ lost: null }));

/** What the tabs say to each other. */
type Message =
  /** Events read from the stream. `from` is where the leader stood before them: a follower behind that has missed some. */
  | { t: "ev"; from: number; events: FeedEvent[] }
  /** Events a tab's own accepted changes came back with, ahead of the stream. */
  | { t: "own"; events: FeedEvent[] }
  /** The leader's stream, and where the leader stands. Also the answer to "hello". */
  | { t: "state"; state: StreamState; seq: number }
  /** A follower asking the leader to say its state. */
  | { t: "hello" }
  /** A follower that saw the server come back asking the leader to make sure its stream did too. */
  | { t: "poke" }
  /** The server said to start over, or to leave: every tab does. */
  | { t: "reset" }
  | { t: "gone" };

type Role = "solo" | "follower" | "leader";

/** Everything one run of startSync holds. Anything still running for an older one finds `cur` changed and stops. */
interface Session {
  slug: string;
  role: Role;
  source: EventStream | null;
  /** Tries to open the stream since it last opened. */
  tries: number;
  channel: BroadcastChannel | null;
  /** Lets go of the leader's lock. */
  release: (() => void) | null;
  /** Gives up waiting for it. */
  lockWait: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  restTimer: ReturnType<typeof setTimeout> | undefined;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  /** When the stream went down, to tell a blip from a long gap. */
  downSince: number;
  /** Counts the copies loaded: an answer for an older copy is dropped. */
  copy: number;
  /** A follower fetching what it missed, and the passed-on events held meanwhile. */
  catching: boolean;
  held: Extract<Message, { t: "ev" }>[];
  /** A follower's unanswered asks. */
  asked: boolean;
  misses: number;
  /** The page is put away (kept for Back and Forward): it holds no connection. */
  parked: boolean;
}

let cur: Session | null = null;

const canShare = typeof BroadcastChannel !== "undefined" && typeof navigator !== "undefined" && "locks" in navigator;
const lockName = (slug: string) => `quadit-stream-${slug}`;

/** Which part this tab plays for the workspace it has open: for tests and for looking into trouble. */
const syncRole = (): Role | "none" => cur?.role ?? "none";

function post(s: Session, msg: Message) {
  try {
    s.channel?.postMessage(msg);
  } catch {
    // A closed channel, or an event that cannot be copied: the others catch up from the server.
  }
}

/** Sets the stream's state here and, from the leader, in every other tab. */
function setStream(s: Session, state: StreamState) {
  showStream(state);
  if (s.role === "leader") post(s, { t: "state", state, seq: getState().seq });
}

/** Puts the stream's state in the store. Live is the surest sign the server is back: what waits to try again does. */
function showStream(state: StreamState) {
  if (getState().stream === state) return;
  useStore.setState({ stream: state });
  if (state === "live") noteReachable();
}

// ---- the starting copy ----

/**
 * Fetches the copy and puts it in the store. The first time, the open work
 * comes alone and the rest follows; a copy that replaces one already on
 * screen comes whole, so finished work does not blink away and back.
 */
async function bootstrap(s: Session, fresh: boolean) {
  const { slug } = s;
  const whole = !fresh && getState().ready && getState().slug === slug;
  const data = await api.get<BootstrapData>(workspacePath(slug, whole ? "/bootstrap" : "/bootstrap?part=open"));
  if (s !== cur) return;
  s.copy++;
  clearTimeout(s.restTimer);
  loadBootstrap(slug, data, { fresh });
  if (!getState().restLoaded) void loadRest(s, s.copy, 0);
}

/** Fetches the finished work and merges it in; keeps trying while the server cannot be reached. */
async function loadRest(s: Session, copy: number, attempt: number) {
  let data: RestData;
  try {
    data = await api.get<RestData>(workspacePath(s.slug, "/bootstrap?part=rest"));
  } catch (err) {
    if (s !== cur || s.copy !== copy) return;
    // Refused: the stream is refused too, and that is where leaving is handled.
    if (err instanceof ApiError && err.status < 500) return;
    s.restTimer = setTimeout(() => void loadRest(s, copy, attempt + 1), backoff(attempt));
    return;
  }
  if (s !== cur || s.copy !== copy) return;
  const missing = mergeRest(s.slug, data);
  if (missing === null) {
    void restart(s, false);
    return;
  }
  // Tasks that were closed when the first part was read and open again by the second are in neither.
  for (const id of missing.slice(0, 50)) {
    api.get<{ task: Task }>(workspacePath(s.slug, `/tasks/${id}?raw=1`)).then(
      (raw) => {
        if (s === cur && s.copy === copy && !getState().collections.tasks[id]) mergeRows("tasks", [raw.task]);
      },
      (err: unknown) => {
        // The task stays out of the copy until the next full load; leave a trace for whoever looks into it.
        // oxlint-disable-next-line no-console -- no place on screen asks for this task, so there is nowhere else to say it
        console.warn(`quadit: could not fetch task ${id} missing from the copy`, err);
      },
    );
  }
}

/** Loads the workspace and follows it. Throws if the first load fails. */
export async function startSync(slug: string) {
  stopSync();
  const s: Session = {
    slug,
    role: canShare ? "follower" : "solo",
    source: null,
    tries: 0,
    channel: null,
    release: null,
    lockWait: null,
    retryTimer: undefined,
    restTimer: undefined,
    pingTimer: undefined,
    downSince: 0,
    copy: 0,
    catching: false,
    held: [],
    asked: false,
    misses: 0,
    parked: false,
  };
  cur = s;
  if (useAccess.getState().lost) useAccess.setState({ lost: null });
  useStore.setState({ stream: "connecting" });
  await bootstrap(s, false);
  if (s !== cur) return;
  // What an earlier page left unsent goes out first.
  void restoreQueue(slug);
  if (s.role === "solo") openStream(s);
  else join(s);
}

export function stopSync() {
  const s = cur;
  cur = null;
  if (!s) return;
  clearTimeout(s.retryTimer);
  clearTimeout(s.restTimer);
  clearInterval(s.pingTimer);
  s.source?.close();
  s.source = null;
  s.release?.();
  s.release = null;
  s.lockWait?.abort();
  s.channel?.close();
  s.channel = null;
}

// ---- the stream (held by the leader, or by every tab where tabs cannot share) ----

function openStream(s: Session) {
  s.source?.close();
  clearTimeout(s.retryTimer);
  const mine = () => s === cur && s.source === stream;
  const stream: EventStream = openEventStream(workspacePath(s.slug, `/events/stream?after=${getState().seq}`), {
    onOpen() {
      if (!mine()) return;
      s.tries = 0;
      const gap = s.downSince ? Date.now() - s.downSince : 0;
      s.downSince = 0;
      if (gap > LONG_GAP_MS) {
        void restart(s, false);
        return;
      }
      setStream(s, "live");
    },

    onEvents(events) {
      if (!mine()) return;
      const from = getState().seq;
      applyEvents(events, true);
      if (s.role === "leader") post(s, { t: "ev", from, events });
    },

    onSignal(name) {
      if (!mine()) return;
      if (name === "reset") {
        // The person's role or projects changed, or the stream fell too far
        // behind: start over from what they may see now. Every tab does.
        stream.close();
        post(s, { t: "reset" });
        void restart(s, true);
      } else if (name === "gone") {
        // Removed, suspended, signed out elsewhere, or the account was disabled.
        stream.close();
        s.source = null;
        post(s, { t: "gone" });
        void leave(s, 0);
      }
    },

    onClose(status) {
      if (!mine()) return;
      s.source = null;
      // The server will not stream to this session at all: nothing to follow.
      if (status === 204) return;
      s.downSince ||= Date.now();
      setStream(s, "down");
      clearTimeout(s.retryTimer);
      const wait = backoff(s.tries++);
      // Dropped, silent or unreachable: open it again from the position
      // applied. Refused: find out why before asking again.
      s.retryTimer = setTimeout(() => (status === null ? openStream(s) : void reopen(s, 0)), wait);
    },
  });
  s.source = stream;
}

type Access = { is: "ok" } | { is: "out" } | { is: "lost"; message: string } | { is: "unknown" };

/**
 * Asks the server whether the person may still be in this workspace.
 * "out": not signed in any more (api.onUnauthorized has already sent them
 * to sign in). "lost": signed in, but removed from the workspace or
 * suspended in it. "unknown": the server could not be asked.
 */
async function checkAccess(slug: string): Promise<Access> {
  try {
    const me = await api.get<{ workspaces: { slug: string }[] }>("/api/v1/auth/me");
    if (!me.workspaces.some((w) => w.slug === slug)) return { is: "lost", message: "" };
    // Still listed: a suspended member is, and the workspace itself says so.
    await api.get(workspacePath(slug, "/me"));
    return { is: "ok" };
  } catch (err) {
    if (!(err instanceof ApiError)) return { is: "unknown" };
    if (err.status === 401) return { is: "out" };
    if (err.status === 403 || err.status === 404) return { is: "lost", message: err.message };
    return { is: "unknown" };
  }
}

/** Empties the copy and says the workspace was lost; the shell shows the way out. */
function loseAccess(slug: string, message: string) {
  stopSync();
  clearStore();
  useAccess.setState({ lost: { slug, message } });
}

/** The server said "gone": find out where to, and go. */
async function leave(s: Session, attempt: number) {
  if (s !== cur) return;
  const access = await checkAccess(s.slug);
  if (s !== cur) return;
  if (access.is === "out") return;
  if (access.is === "lost") return loseAccess(s.slug, access.message);
  if (access.is === "unknown") {
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => void leave(s, attempt + 1), backoff(attempt));
    return;
  }
  // Let back in meanwhile: start over with what they may see now.
  void restart(s, true);
}

/** Reopens a stream the server refused, once it is known the person may still have it. */
async function reopen(s: Session, attempt: number) {
  if (s !== cur || s.role === "follower" || s.parked) return;
  const access = await checkAccess(s.slug);
  // Another tab may have taken the stream over while the answer was on its way.
  if (s !== cur || (s.role as Role) === "follower" || s.parked) return;
  if (access.is === "out") return;
  if (access.is === "lost") return loseAccess(s.slug, access.message);
  if (access.is === "unknown") {
    s.retryTimer = setTimeout(() => void reopen(s, attempt + 1), backoff(attempt));
    return;
  }
  if (s.downSince && Date.now() - s.downSince > LONG_GAP_MS) await restart(s, false);
  else openStream(s);
}

/**
 * Fetches a fresh copy, then (in the tab that holds the stream) follows the
 * stream from it. `fresh` keeps nothing of the copy before.
 */
async function restart(s: Session, fresh: boolean, attempt = 0) {
  if (s !== cur) return;
  s.source?.close();
  s.source = null;
  clearTimeout(s.retryTimer);
  try {
    await bootstrap(s, fresh);
  } catch (err) {
    if (s !== cur) return;
    if (err instanceof ApiError && err.status === 401) return;
    // Refused outright: asking again will not help. Leave instead of looping.
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return loseAccess(s.slug, err.message);
    s.retryTimer = setTimeout(() => void restart(s, fresh, attempt + 1), backoff(attempt));
    return;
  }
  if (s !== cur) return;
  s.downSince = 0;
  s.held = [];
  if (s.parked) return;
  if (s.role === "follower") {
    // The leader's stream is the one that counts; ask how it is doing.
    s.asked = true;
    post(s, { t: "hello" });
  } else {
    openStream(s);
  }
}

// ---- sharing one stream between tabs ----

/** Joins the tabs of this workspace: listens to them, and stands in line to lead. */
function join(s: Session) {
  const channel = new BroadcastChannel(lockName(s.slug));
  s.channel = channel;
  channel.onmessage = (e) => {
    if (s === cur) hear(s, e.data as Message);
  };
  s.asked = true;
  post(s, { t: "hello" });
  s.pingTimer = setInterval(() => ping(s), PING_MS);
  standForLeader(s, false);
}

/**
 * Asks for the leader's lock. It is granted when no other tab holds it:
 * at once for the first tab, or when the leader's tab closes. With `take`
 * it is taken from a leader that stopped answering.
 */
function standForLeader(s: Session, take: boolean) {
  s.lockWait?.abort();
  const wait = new AbortController();
  s.lockWait = wait;
  const granted = () => {
    if (s !== cur || s.parked || s.role === "leader") return undefined;
    return new Promise<void>((resolve) => {
      s.release = resolve;
      s.role = "leader";
      s.held = [];
      openStream(s);
    });
  };
  // "steal" and "signal" cannot be given together.
  const asking = take
    ? navigator.locks.request(lockName(s.slug), { steal: true }, granted)
    : navigator.locks.request(lockName(s.slug), { signal: wait.signal }, granted);
  asking.catch(() => {
    // Either this tab stopped waiting, or another tab took the lock from it.
    if (s !== cur || s.role !== "leader" || s.lockWait !== wait) return;
    s.role = "follower";
    s.release = null;
    s.source?.close();
    s.source = null;
    clearTimeout(s.retryTimer);
    s.asked = true;
    post(s, { t: "hello" });
    standForLeader(s, false);
  });
}

function hear(s: Session, msg: Message) {
  switch (msg.t) {
    case "own":
      applyEvents(msg.events, false);
      return;
    case "hello":
      if (s.role === "leader") post(s, { t: "state", state: getState().stream, seq: getState().seq });
      return;
    case "poke":
      if (s.role === "leader") refresh(s);
      return;
  }
  // The rest is the leader speaking; a leader hears it only while two tabs briefly both think they lead.
  if (s.role !== "follower") return;
  switch (msg.t) {
    case "ev":
      take(s, msg);
      return;
    case "state":
      s.asked = false;
      s.misses = 0;
      showStream(msg.state);
      if (msg.seq > getState().seq) void catchUp(s);
      return;
    case "reset":
      void restart(s, true);
      return;
    case "gone":
      void leave(s, 0);
      return;
  }
}

/** A follower applies events passed on by the leader, unless it has missed some before them. */
function take(s: Session, msg: Extract<Message, { t: "ev" }>) {
  if (s.catching || msg.from > getState().seq) {
    s.held.push(msg);
    void catchUp(s);
    return;
  }
  applyEvents(msg.events, true);
}

/** A follower fetches the events after its position from the server. */
async function catchUp(s: Session) {
  if (s !== cur || s.catching) return;
  if (getState().me?.scope?.projects?.length) {
    // For someone who sees only some projects, GET /events leaves out what
    // belongs to no project (members, shared labels) though the stream
    // carries it. A fresh copy misses nothing.
    s.held = [];
    s.catching = true;
    await restart(s, false);
    s.catching = false;
    return;
  }
  s.catching = true;
  let ok = true;
  try {
    for (let page = 0; ; page++) {
      const out = await api.get<{ events: FeedEvent[]; seq: number; more: boolean }>(
        workspacePath(s.slug, `/events?after=${getState().seq}&limit=2000`),
      );
      if (s !== cur) return;
      applyEvents(out.events, true);
      if (out.seq > getState().seq) useStore.setState({ seq: out.seq });
      if (!out.more) break;
      if (page + 1 >= CATCH_UP_PAGES) {
        // Too far behind to replay.
        s.held = [];
        void restart(s, false);
        return;
      }
    }
  } catch (err) {
    ok = false;
    if (s === cur && err instanceof ApiError && (err.status === 403 || err.status === 404)) void leave(s, 0);
  } finally {
    s.catching = false;
  }
  if (s !== cur) return;
  const waiting = s.held;
  s.held = [];
  // Without the events before them these cannot be applied; the next ask finds the gap again.
  if (!ok || s.role !== "follower") return;
  for (const msg of waiting) take(s, msg);
}

/** A follower asks the leader whether it is there. A leader that does not answer is replaced. */
function ping(s: Session) {
  if (s !== cur || s.role !== "follower" || s.parked) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (s.asked) {
    s.misses++;
    // Nobody is passing events on: fetch them.
    void catchUp(s);
    if (s.misses >= PING_MISSES) {
      s.misses = 0;
      s.asked = false;
      standForLeader(s, true);
      return;
    }
  }
  s.asked = true;
  post(s, { t: "hello" });
}

/** Opens the stream anew from the position applied, in case the one held died without saying so. */
function refresh(s: Session) {
  if (s !== cur || s.parked || s.role === "follower") return;
  // One already waiting to be reopened is brought forward; a refusal is still looked into first.
  if (s.source || getState().stream === "down") openStream(s);
}

// A change that could not be sent and now could means the server was away
// and is back. The stream should have noticed; make sure of it.
useStore.subscribe((state, prev) => {
  const s = cur;
  if (!s || !prev.offline || state.offline) return;
  if (s.role === "follower") post(s, { t: "poke" });
  else refresh(s);
});

// The events a tab's own accepted changes came back with go to the other
// tabs at once, so that all of them agree before the stream brings them.
onOwnEvents((events, slug) => {
  if (cur && cur.slug === slug) post(cur, { t: "own", events });
});

if (typeof window !== "undefined") {
  // A page the browser keeps for Back and Forward must not keep its stream
  // or the leader's lock: a kept page would hold the connection every other
  // tab relies on. Both are let go when the page is put away and asked for
  // again if it is shown again.
  window.addEventListener("pagehide", () => {
    const s = cur;
    if (!s) return;
    s.parked = true;
    clearTimeout(s.retryTimer);
    s.source?.close();
    s.source = null;
    s.downSince ||= Date.now();
    s.lockWait?.abort();
    s.lockWait = null;
    s.release?.();
    s.release = null;
    if (s.role === "leader") s.role = "follower";
  });
  window.addEventListener("pageshow", (e) => {
    const s = cur;
    if (!e.persisted || !s?.parked) return;
    s.parked = false;
    if (!getState().ready || getState().slug !== s.slug) return;
    if (s.role === "solo") {
      useStore.setState({ stream: "connecting" });
      void reopen(s, 0);
      return;
    }
    s.downSince = 0;
    s.asked = true;
    post(s, { t: "hello" });
    void catchUp(s);
    standForLeader(s, false);
  });
  // A follower shown again after a while in the background checks that it missed nothing.
  document.addEventListener("visibilitychange", () => {
    const s = cur;
    if (!s || s.role !== "follower" || document.visibilityState !== "visible") return;
    post(s, { t: "hello" });
  });
  window.addEventListener("online", () => {
    const s = cur;
    if (!s) return;
    if (s.role === "follower") post(s, { t: "hello" });
    else refresh(s);
  });
}

// In development the moving parts can be looked at from the console:
// __quadit.store.getState(), __quadit.role(), __quadit.access.getState().
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __quadit?: unknown }).__quadit = { store: useStore, role: syncRole, access: useAccess };
}

// The connection and the tab's place among the tabs live in this module;
// hot-swapping it in development would leave the old one running beside a
// new one that knows nothing. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

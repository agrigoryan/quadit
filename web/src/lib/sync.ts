// Keeps the store current: a starting copy, then the live stream.
//
// The starting copy comes in two parts. The open work is fetched first and
// the app shows; the finished work (done, canceled and archived tasks) is
// fetched behind it and merged in when it lands (store.restLoaded says when).
//
// All tabs of one workspace share one live connection (lib/tab-share.ts
// picks the tab that leads). The leader holds the stream
// (lib/event-stream.ts) and passes each event, and the state of the stream,
// to the others, which apply what they are passed exactly as if they had
// read the stream themselves. When the lead falls to another tab, that tab
// opens the stream from its own position. A follower that notices it missed
// something asks the server for the events after its position.
//
// If the stream drops it is reopened from the last position applied; after a
// long gap, or when the server says "reset" (the person's role or projects
// changed), the whole copy is fetched again. When the server says "gone", or
// refuses the workspace on reconnect, the copy is emptied.
//
// Whether the workspace can be shown, and if not why (still loading, the
// server out of reach, refused, lost while open), is one value,
// `useAvailability`. The shell draws it and decides nothing.
//
// One run of startSync is a session. Everything a session asks the server
// or waits for is given the session's abort signal, so when the session ends
// nothing of it arrives late: the request or the wait rejects instead.

import { create } from "zustand";
import {
  api,
  ApiError,
  errorMessage,
  NetworkError,
  noteReachable,
  onReachableAgain,
  whenReachable,
  workspacePath,
} from "@/lib/api";
import { openEventStream } from "@/lib/event-stream";
import { restoreQueue } from "@/lib/mutate";
import {
  applyEvents,
  type BootstrapData,
  clearStore,
  getState,
  loadBootstrap,
  mergeRest,
  mergeRows,
  onEvents,
  onOwnEvents,
  type RestData,
  type StreamState,
  useStore,
} from "@/lib/store";
import { join, type TabShare } from "@/lib/tab-share";
import type { FeedEvent, Task } from "@/types/core";

/** Past this long without the stream, start from a fresh copy instead of replaying. */
const LONG_GAP_MS = 5 * 60_000;
/** A follower this many pages of events behind fetches a fresh copy instead. */
const CATCH_UP_PAGES = 3;
/** Past this many events applied while the finished work was on its way, patching it is not worth it: the whole copy is fetched again. */
const MEANWHILE_MAX = 20_000;

/** Whether a workspace can be shown and, if not, why. A `message` is the server's own words. */
export type Availability =
  /** Its copy is on its way. */
  | { is: "loading" }
  /** Its copy is in the store. How current it is kept is another matter: store.stream says. */
  | { is: "ready" }
  /** The server cannot be reached. It is asked again without anyone's help. */
  | { is: "offline" }
  /** The person may not open it: it is not theirs, or there is no such workspace. */
  | { is: "refused"; message: string }
  /**
   * They had it open and were removed from it or suspended in it; the copy
   * has been emptied. (Someone signed out goes to the sign-in page through
   * api.onUnauthorized instead.)
   */
  | { is: "lost"; message: string }
  /** The install requires a second sign-in step and the person has not set one up. */
  | { is: "second-step-needed" }
  /** The server answered with a failure of its own. It is not asked again until startSync is called again. */
  | { is: "failed"; message: string };

type Unavailable = Exclude<Availability, { is: "loading" } | { is: "ready" }>;

const LOADING: Availability = { is: "loading" };
const READY: Availability = { is: "ready" };

/** Why the workspace last asked for is not on screen, when there is more to say than "loading". Written only by this file. */
const whyNot = create<{ slug: string; why: Unavailable | null }>(() => ({ slug: "", why: null }));

/**
 * How it stands with showing the workspace `slug`. A copy in the store
 * counts before anything else: one kept from an earlier visit stays on
 * screen while a newer one is fetched.
 */
export function availability(slug: string): Availability {
  const copy = getState();
  if (copy.ready && copy.slug === slug) return READY;
  const asked = whyNot.getState();
  return (asked.slug === slug && asked.why) || LOADING;
}

/** `availability` for components: re-renders when it changes. */
export function useAvailability(slug: string): Availability {
  const ready = useStore((s) => s.ready && s.slug === slug);
  const why = whyNot((s) => (s.slug === slug ? s.why : null));
  return ready ? READY : (why ?? LOADING);
}

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

type PassedOn = Extract<Message, { t: "ev" }>;

/** One run of startSync, and what is under way in it. */
interface Session {
  slug: string;
  /** Aborted by stopSync. Every request and wait of the session ends with it. */
  ending: AbortController;
  /** The tabs of this workspace; null until the first copy has arrived. */
  tabs: TabShare<Message> | null;
  /** This tab holds the stream for all the tabs of the workspace. */
  leads: boolean;
  /** The page is put away (kept for Back and Forward): it holds no connection. */
  parked: boolean;
  /** The stream this tab holds, with whatever waits to reopen it; aborting lets go of it. Null while it holds none. */
  stream: AbortController | null;
  /** When the stream went down, to tell a blip from a long gap; 0 while it is up. */
  downSince: number;
  /** The finished work on its way for the copy in the store; a newer copy gives it up. */
  rest: AbortController | null;
  /**
   * A copy on its way to replace the one in the store, asked for until it
   * comes. While there is one, no stream is opened: it would follow the copy
   * about to be thrown away.
   */
  reload: { fresh: boolean; giveUp: AbortController } | null;
  /** A follower fetching what it missed, and the events passed on to it meanwhile. */
  catchingUp: boolean;
  passedOn: PassedOn[];
}

let cur: Session | null = null;

/** A signal for one part of the session's work: aborted when the part is given up, and when the session ends. */
const within = (s: Session, part: AbortController) => AbortSignal.any([s.ending.signal, part.signal]);

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";

/**
 * Starts work of the session that nothing waits for. When the session, or
 * the part of it the work belongs to, is given up, the work's request or
 * wait rejects and the work ends there: that is how it is meant to stop.
 * Anything else it throws is a fault, left to surface.
 */
function run(work: Promise<unknown>) {
  // Not awaited: what the work finds shows in the store.
  void work.catch((err: unknown) => {
    if (!isAbort(err)) throw err;
  });
}

/** Puts the stream's state in the store and, from the leader, tells every other tab. */
function setStream(s: Session, state: StreamState) {
  showStream(state);
  if (s.leads) s.tabs?.post({ t: "state", state, seq: getState().seq });
}

/** Puts the stream's state in the store. Live is the surest sign the server is back: what waits to try again does. */
function showStream(state: StreamState) {
  if (getState().stream === state) return;
  useStore.setState({ stream: state });
  if (state === "live") noteReachable();
}

/** A follower asks the leader how the stream is doing and where it stands. */
const askState = (s: Session) => s.tabs?.post({ t: "hello" });

// ---- the copy ----

/**
 * Fetches the copy once and puts it in the store. The first time, the open
 * work comes alone and the rest follows; a copy that replaces one already
 * on screen comes whole, so finished work does not blink away and back.
 * `fresh` keeps nothing of the copy before.
 */
async function fetchCopy(s: Session, fresh: boolean, signal: AbortSignal) {
  const whole = !fresh && getState().ready && getState().slug === s.slug;
  const data = await api.get<BootstrapData>(
    workspacePath(s.slug, whole ? "/bootstrap" : "/bootstrap?part=open"),
    signal,
  );
  s.rest?.abort();
  s.rest = null;
  loadBootstrap(s.slug, data, { fresh });
  if (!getState().restLoaded) run(loadRest(s));
}

/**
 * Fetches the finished work for the copy just put in the store and merges
 * it in, asking again for as long as the server cannot be reached. The rows
 * are read on the server a moment after the first part was, so every event
 * the store applies meanwhile is noted here and applied again over them.
 */
async function loadRest(s: Session) {
  const loading = new AbortController();
  s.rest = loading;
  const signal = within(s, loading);
  const meanwhile: FeedEvent[] = [];
  const stopNoting = onEvents((events) => {
    // Past the limit nothing more is noted: the whole copy is then asked for again.
    if (meanwhile.length <= MEANWHILE_MAX) meanwhile.push(...events);
  });
  try {
    for (let attempt = 0; ; attempt++) {
      let data: RestData;
      try {
        data = await api.get<RestData>(workspacePath(s.slug, "/bootstrap?part=rest"), signal);
      } catch (err) {
        // Refused: the stream is refused too, and that is where leaving is handled.
        if (err instanceof ApiError && err.status < 500) return;
        await whenReachable(attempt, signal);
        continue;
      }
      if (meanwhile.length > MEANWHILE_MAX) return run(reloadCopy(s, false));
      const missing = mergeRest(s.slug, data, meanwhile);
      // Tasks that were closed when the first part was read and open again by the second are in neither.
      for (const id of missing.slice(0, 50)) {
        api.get<{ task: Task }>(workspacePath(s.slug, `/tasks/${id}?raw=1`), signal).then(
          (raw) => {
            if (!getState().collections.tasks[id]) mergeRows("tasks", [raw.task]);
          },
          (err: unknown) => {
            // Given up with the copy it was for: nothing to say.
            if (signal.aborted) return;
            // The task stays out of the copy until the next full load; leave a trace for whoever looks into it.
            // oxlint-disable-next-line no-console -- no place on screen asks for this task, so there is nowhere else to say it
            console.warn(`quadit: could not fetch task ${id} missing from the copy`, err);
          },
        );
      }
      return;
    }
  } finally {
    stopNoting();
  }
}

/**
 * Replaces the copy in the store with a new one from the server, asking for
 * as long as it takes to get it; then, in the tab that leads, follows the
 * stream from the new copy. `fresh` keeps nothing of the copy before.
 */
async function reloadCopy(s: Session, fresh: boolean) {
  // One at a time. A new reason to reload starts the asking over (the answer
  // on its way may be older than the reason), and "keep nothing" sticks.
  s.reload?.giveUp.abort();
  const reload = { fresh: fresh || !!s.reload?.fresh, giveUp: new AbortController() };
  s.reload = reload;
  dropStream(s);
  const signal = within(s, reload.giveUp);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchCopy(s, reload.fresh, signal);
        break;
      } catch (err) {
        // Signed out: api.onUnauthorized has taken over.
        if (err instanceof ApiError && err.status === 401) return;
        // Refused outright: asking again will not help. Leave instead of looping.
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return loseAccess(s, err.message);
        await whenReachable(attempt, signal);
      }
    }
  } finally {
    if (s.reload === reload) s.reload = null;
  }
  s.downSince = 0;
  s.passedOn = [];
  if (s.parked) return;
  // A follower's stream is the leader's: ask how that one is doing.
  if (s.leads) holdStream(s);
  else askState(s);
}

/**
 * Opens the workspace: loads its copy and keeps it current, until stopSync.
 * Throws nothing and returns at once: `useAvailability(slug)` says how it
 * goes. Calling it again starts over, which is what "try again" does.
 */
export function startSync(slug: string) {
  stopSync();
  const s: Session = {
    slug,
    ending: new AbortController(),
    tabs: null,
    leads: false,
    parked: false,
    stream: null,
    downSince: 0,
    rest: null,
    reload: null,
    catchingUp: false,
    passedOn: [],
  };
  cur = s;
  whyNot.setState({ slug, why: null });
  useStore.setState({ stream: "connecting" });
  listen(s);
  run(open(s));
}

/**
 * Loads the session's first copy, asking again for as long as the server
 * cannot be reached, then joins the tabs of the workspace. Anything but
 * "cannot be reached" ends it there, with the reason in `availability`.
 */
async function open(s: Session) {
  const { slug } = s;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetchCopy(s, false, s.ending.signal);
      break;
    } catch (err) {
      if (isAbort(err)) throw err;
      // Signed out: api.onUnauthorized has taken over.
      if (err instanceof ApiError && err.status === 401) return;
      if (!(err instanceof NetworkError)) {
        const why = whyNotOpened(err);
        // The server will not show this workspace to the person now: a copy from an earlier visit is not theirs to keep looking at.
        if (why.is !== "failed") clearStore();
        return whyNot.setState({ slug, why });
      }
      whyNot.setState({ slug, why: { is: "offline" } });
      // A copy from an earlier visit may be on screen meanwhile: say that it is not being kept current.
      showStream("down");
      await whenReachable(attempt, s.ending.signal);
    }
  }
  if (whyNot.getState().why) {
    whyNot.setState({ slug, why: null });
    useStore.setState({ stream: "connecting" });
  }
  // What an earlier page left unsent goes out first.
  void restoreQueue(slug);
  s.tabs = join<Message>(`quadit-tabs-${slug}`, {
    onLead() {
      s.leads = true;
      s.passedOn = [];
      // A copy on its way opens the stream itself when it lands.
      if (!s.reload) holdStream(s);
    },
    onFollow() {
      s.leads = false;
      dropStream(s);
      askState(s);
    },
    onMessage: (msg) => hear(s, msg),
  });
  // Put away while its copy was on its way.
  if (s.parked) s.tabs.park();
  askState(s);
}

/** Why a first copy that the server was asked for did not come. */
function whyNotOpened(err: unknown): Unavailable {
  if (err instanceof ApiError && err.code === "second_step_required") return { is: "second-step-needed" };
  const refused = err instanceof ApiError && (err.status === 403 || err.status === 404);
  return { is: refused ? "refused" : "failed", message: errorMessage(err) };
}

/** Ends the session: nothing more of it reaches the store. The copy stays where it is. */
export function stopSync() {
  const s = cur;
  cur = null;
  if (!s) return;
  s.tabs?.leave();
  s.ending.abort();
}

/** What a session listens to outside itself, for as long as it lasts. */
function listen(s: Session) {
  const signal = s.ending.signal;
  // The events a tab's own accepted changes came back with go to the other
  // tabs at once, so that all of them agree before the stream brings them.
  const stopPassingOwn = onOwnEvents((events, slug) => {
    if (slug === s.slug) s.tabs?.post({ t: "own", events });
  });
  // A call that got an answer after one that got none means the server was
  // away and is back. The stream should have noticed; make sure of it.
  const stopHearingBack = onReachableAgain(() => {
    if (s.leads) reconnectNow(s);
    else s.tabs?.post({ t: "poke" });
  });
  signal.addEventListener("abort", () => {
    stopPassingOwn();
    stopHearingBack();
  });
  if (typeof window === "undefined") return;

  // A page the browser keeps for Back and Forward must not keep its stream
  // or the lead: a kept page would hold the connection every other tab
  // relies on. Both are let go when the page is put away and asked for
  // again if it is shown again.
  window.addEventListener(
    "pagehide",
    () => {
      s.parked = true;
      s.downSince ||= Date.now();
      // If this tab led, onFollow lets go of the stream.
      s.tabs?.park();
    },
    { signal },
  );
  window.addEventListener(
    "pageshow",
    (e) => {
      if (!e.persisted || !s.parked) return;
      s.parked = false;
      // Put away before its copy arrived: it joins the tabs when it does.
      if (!s.tabs) return;
      s.downSince = 0;
      s.tabs.unpark();
      askState(s);
      run(catchUp(s));
    },
    { signal },
  );
  // A follower shown again after a while in the background checks that it missed nothing.
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!s.leads && document.visibilityState === "visible") askState(s);
    },
    { signal },
  );
  window.addEventListener(
    "online",
    () => {
      if (s.leads) reconnectNow(s);
      else askState(s);
    },
    { signal },
  );
}

// ---- the stream (held by the tab that leads) ----

/** Lets go of the stream, and of whatever was waiting to reopen it. */
function dropStream(s: Session) {
  s.stream?.abort();
  s.stream = null;
}

/** Holds the stream from the position applied, until dropStream. Replaces a stream already held. */
function holdStream(s: Session) {
  dropStream(s);
  const held = new AbortController();
  s.stream = held;
  run(followStream(s, within(s, held)));
}

/** Opens the stream anew, in case the one held died without saying so. Does nothing in a tab that holds none. */
function reconnectNow(s: Session) {
  if (s.stream) holdStream(s);
}

/**
 * Reads the stream into the store and passes it on to the other tabs, for
 * as long as `held` lasts. A stream that drops is opened again from the
 * position applied, after a wait that grows with each failure in a row; one
 * the server refuses is opened again only once it is known the person may
 * still be here.
 */
async function followStream(s: Session, held: AbortSignal) {
  for (let tries = 0; ;) {
    const status = await new Promise<number | null>((closed, dropped) => {
      const drop = () => {
        stream.close();
        dropped(held.reason);
      };
      const stream = openEventStream(workspacePath(s.slug, `/events/stream?after=${getState().seq}`), {
        onOpen() {
          tries = 0;
          const gap = s.downSince ? Date.now() - s.downSince : 0;
          s.downSince = 0;
          if (gap > LONG_GAP_MS) run(reloadCopy(s, false));
          else setStream(s, "live");
        },

        onEvents(events) {
          const from = getState().seq;
          applyEvents(events, true);
          if (s.leads) s.tabs?.post({ t: "ev", from, events });
        },

        onSignal(name) {
          if (name === "reset") {
            // The person's role or projects changed, or the stream fell too far
            // behind: start over from what they may see now. Every tab does.
            s.tabs?.post({ t: "reset" });
            run(reloadCopy(s, true));
          } else if (name === "gone") {
            // Removed, suspended, signed out elsewhere, or the account was disabled.
            s.tabs?.post({ t: "gone" });
            run(leave(s));
          }
        },

        onClose(status) {
          held.removeEventListener("abort", drop);
          closed(status);
        },
      });
      held.addEventListener("abort", drop);
    });

    // The server will not stream to this session at all: nothing to follow.
    if (status === 204) return dropStream(s);
    s.downSince ||= Date.now();
    setStream(s, "down");
    await whenReachable(tries++, held);
    // Dropped, silent or unreachable: open it again. Refused: find out why first.
    if (status === null) continue;
    const access = await checkAccess(s.slug, held);
    if (access.is === "out") return;
    if (access.is === "lost") return loseAccess(s, access.message);
    if (Date.now() - s.downSince > LONG_GAP_MS) return run(reloadCopy(s, false));
  }
}

type Access = { is: "ok" } | { is: "out" } | { is: "lost"; message: string };

/**
 * Asks the server whether the person may still be in this workspace, for
 * as long as it takes to get an answer. "out": not signed in any more
 * (api.onUnauthorized has already sent them to sign in). "lost": signed in,
 * but removed from the workspace or suspended in it.
 */
async function checkAccess(slug: string, signal: AbortSignal): Promise<Access> {
  for (let attempt = 0; ; attempt++) {
    try {
      const me = await api.get<{ workspaces: { slug: string }[] }>("/api/v1/auth/me", signal);
      if (!me.workspaces.some((w) => w.slug === slug)) return { is: "lost", message: "" };
      // Still listed: a suspended member is, and the workspace itself says so.
      await api.get(workspacePath(slug, "/me"), signal);
      return { is: "ok" };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return { is: "out" };
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        return { is: "lost", message: err.message };
      }
      // The server could not be asked: ask again.
      await whenReachable(attempt, signal);
    }
  }
}

/** Ends the session, empties the copy and says the workspace was lost; the shell shows the way out. */
function loseAccess(s: Session, message: string) {
  stopSync();
  clearStore();
  whyNot.setState({ slug: s.slug, why: { is: "lost", message } });
}

/** The server said "gone": find out where the person stands now, and act on it. */
async function leave(s: Session) {
  dropStream(s);
  const access = await checkAccess(s.slug, s.ending.signal);
  if (access.is === "out") return;
  if (access.is === "lost") return loseAccess(s, access.message);
  // Let back in meanwhile: start over with what they may see now.
  await reloadCopy(s, true);
}

// ---- following the tab that leads ----

function hear(s: Session, msg: Message) {
  switch (msg.t) {
    case "own":
      applyEvents(msg.events, false);
      return;
    case "hello":
      if (s.leads) s.tabs?.post({ t: "state", state: getState().stream, seq: getState().seq });
      return;
    case "poke":
      if (s.leads) reconnectNow(s);
      return;
  }
  // The rest is the leader speaking; a leader hears it only while two tabs briefly both think they lead.
  if (s.leads) return;
  switch (msg.t) {
    case "ev":
      take(s, msg);
      return;
    case "state":
      showStream(msg.state);
      if (msg.seq > getState().seq) run(catchUp(s));
      return;
    case "reset":
      run(reloadCopy(s, true));
      return;
    case "gone":
      run(leave(s));
      return;
  }
}

/** A follower applies events passed on by the leader, unless it has missed some before them. */
function take(s: Session, msg: PassedOn) {
  if (s.catchingUp || msg.from > getState().seq) {
    s.passedOn.push(msg);
    run(catchUp(s));
    return;
  }
  applyEvents(msg.events, true);
}

/** A follower fetches the events after its position from the server, then applies what was passed on meanwhile. */
async function catchUp(s: Session) {
  if (s.catchingUp) return;
  s.catchingUp = true;
  let caughtUp = false;
  try {
    if (getState().me?.scope?.projects?.length) {
      // For someone who sees only some projects, GET /events leaves out what
      // belongs to no project (members, shared labels) though the stream
      // carries it. A fresh copy misses nothing.
      s.passedOn = [];
      await reloadCopy(s, false);
      return;
    }
    for (let page = 0; ; page++) {
      const out = await api.get<{ events: FeedEvent[]; seq: number; more: boolean }>(
        workspacePath(s.slug, `/events?after=${getState().seq}&limit=2000`),
        s.ending.signal,
      );
      applyEvents(out.events, true);
      if (out.seq > getState().seq) useStore.setState({ seq: out.seq });
      if (!out.more) break;
      if (page + 1 >= CATCH_UP_PAGES) {
        // Too far behind to replay.
        s.passedOn = [];
        run(reloadCopy(s, false));
        return;
      }
    }
    caughtUp = true;
  } catch (err) {
    if (!(err instanceof ApiError || err instanceof NetworkError)) throw err;
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) run(leave(s));
  } finally {
    s.catchingUp = false;
  }
  const waiting = s.passedOn;
  s.passedOn = [];
  // Without the events before them these cannot be applied; the next ask finds the gap again.
  if (!caughtUp || s.leads) return;
  for (const msg of waiting) take(s, msg);
}

// In development the moving parts can be looked at from the console:
// __quadit.store.getState(), __quadit.leads(), __quadit.availability("games").
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __quadit?: unknown }).__quadit = {
    store: useStore,
    leads: () => cur?.leads ?? false,
    availability,
  };
}

// The connection and the tab's place among the tabs live in this module;
// hot-swapping it in development would leave the old one running beside a
// new one that knows nothing. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

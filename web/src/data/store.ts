// The browser's copy of one workspace: every row, in collections keyed by
// id. data/sync.ts fills it from /bootstrap (the open work first, the finished
// work a moment later) and then keeps it current from the event feed;
// data/mutate.ts puts the person's own edits in. Pages read from here and never ask
// the server for a list.
//
// The data folder: everything the app knows from the server and how it stays
// current. The workspace copy is this file with collections.ts (its shape),
// apply.ts (how a row or a feed event changes it), sync.ts with
// event-stream.ts and tab-share.ts (the starting copy and the live stream,
// shared by the tabs), mutate.ts with outbox.ts (the person's own edits, kept
// on the device until sent), and selectors.ts and access.ts (how the app
// reads it, and what the member may do). Beside it: api.ts, the one place
// that talks HTTP; query.ts, live.ts, task-detail.ts, listening.ts and
// change-catalog.ts, the reads the copy does not hold; and files.ts, uploads. Nothing here knows
// the router or the interface.

import { create } from "zustand";
import { applyEvent, CopyOnWrite, normalize, targetsOf } from "@/data/apply";
import {
  type AnyRow,
  type CollectionName,
  type Collections,
  type Dict,
  emptyCollections,
  keyOf,
} from "@/data/collections";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";

// The collections' types are declared in data/collections.ts; the app reads them from the store.
export type { CollectionName, Collections, Dict };

export type StreamState = "connecting" | "live" | "down";

export interface StoreState {
  slug: string;
  ready: boolean;
  /** The last feed position applied from the live stream, in order. */
  seq: number;
  me: Member | null;
  user: User | null;
  workspace: Workspace | null;
  collections: Collections;
  /** Tasks whose description, comments and files have been fetched. */
  opened: Dict<true>;
  stream: StreamState;
  /** Edits made but not yet confirmed by the server. */
  unsent: number;
  /** True after a send failed for lack of a connection, until one succeeds. */
  offline: boolean;
  /**
   * False while the finished work (done, canceled and archived tasks, and
   * what hangs on them) is still on its way. Until it is true, a list of
   * done work is not complete: say "Loading finished work…" instead of "none".
   */
  restLoaded: boolean;
  /**
   * Rows made here that the server has not confirmed yet, by id (the value
   * is the collection). A task in here is a draft: it has no number yet.
   */
  drafts: Dict<CollectionName>;
  /**
   * Keys of projects the person could see until their access was narrowed
   * while the app was open. A page or task of one of them says so instead
   * of "there is nothing at this address".
   */
  lostProjects: string[];
}

export const useStore = create<StoreState>(() => ({
  slug: "",
  ready: false,
  seq: 0,
  me: null,
  user: null,
  workspace: null,
  collections: emptyCollections(),
  opened: {},
  stream: "connecting",
  unsent: 0,
  offline: false,
  restLoaded: false,
  drafts: {},
  lostProjects: [],
}));

export const getState = useStore.getState;

/** True while a row made here waits for the server: a new task before it has its number. */
export const isDraft = (id: string | undefined): boolean => !!id && id in getState().drafts;

/** isDraft for components: re-renders when the row is confirmed. */
export const useIsDraft = (id: string | undefined): boolean => useStore((s) => !!id && id in s.drafts);

/** How a draft task's key reads until the server numbers it: "SVA-…". */
export const draftKey = (projectKey: string) => `${projectKey}-…`;

// A mark for the server's picture-taking browser: the page has all its
// data. It follows the store, whichever way the data arrived (in one part,
// or open work first and the rest after).
if (typeof document !== "undefined") {
  useStore.subscribe((s) => {
    const mark = s.restLoaded ? "1" : "";
    if (document.documentElement.dataset.loaded !== mark) document.documentElement.dataset.loaded = mark;
  });
}

/** False until the finished work has arrived (see StoreState.restLoaded). */
export const useRestLoaded = (): boolean => useStore((s) => s.restLoaded);

type EventListener = (events: FeedEvent[]) => void;
const listeners = new Set<EventListener>();

/**
 * Hear the events the store applies (a task's timeline follows along this
 * way). The listener is called after each batch is in the store, with the
 * events of it that were past the store's position.
 *
 * An event can be heard twice: one that a change made in this browser came
 * back with is applied early (in the tab that made it and, passed on, in
 * the person's other tabs) and again when the live stream delivers it in
 * its place. A listener must come to the same result either way.
 *
 * Returns the function that stops the listening.
 */
export function onEvents(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies feed events. Events from the live stream arrive in order and move
 * `seq`; events returned by a write are applied early and do not, because
 * the stream will deliver them again in their place.
 */
export function applyEvents(events: FeedEvent[], fromStream: boolean) {
  const { seq, collections: c, drafts } = getState();
  const fresh = events.filter((ev) => ev.seq > seq);
  if (fresh.length === 0) return;
  const d = new CopyOnWrite(c);
  let last = seq;
  let confirmed: Dict<CollectionName> | null = null;
  for (const ev of fresh) {
    last = Math.max(last, ev.seq);
    if (ev.entity_type === "workspace" && ev.data?.changes) continue;
    applyEvent(d, ev);
    // The server's own row for something made here: it is no longer a draft.
    const id = ev.data?.row ? String(ev.data.row.id) : "";
    if (id && id in drafts) {
      confirmed ??= { ...drafts };
      delete confirmed[id];
    }
  }
  const workspacePatch = workspaceChanges(fresh);
  const next = d.done();
  useStore.setState((s) => ({
    collections: next,
    // The signed-in member is a row like any other: follow its role, name and avatar.
    me: (s.me && next.members[s.me.user_id]) || s.me,
    seq: fromStream ? last : s.seq,
    workspace: s.workspace && workspacePatch ? { ...s.workspace, ...workspacePatch } : s.workspace,
    drafts: confirmed ?? s.drafts,
  }));
  for (const listener of listeners) listener(fresh);
}

type OwnListener = (events: FeedEvent[], slug: string) => void;
const ownListeners = new Set<OwnListener>();

/** Hear the events this tab's own accepted changes came back with (data/sync.ts passes them to the other tabs). */
export function onOwnEvents(listener: OwnListener): () => void {
  ownListeners.add(listener);
  return () => ownListeners.delete(listener);
}

/**
 * Applies the events a write of this tab was answered with, ahead of the
 * stream, and hands them on so the person's other tabs show them at once.
 */
export function applyOwnEvents(slug: string, events: FeedEvent[]) {
  if (events.length === 0) return;
  if (getState().slug === slug) applyEvents(events, false);
  for (const listener of ownListeners) listener(events, slug);
}

function workspaceChanges(events: FeedEvent[]): Partial<Workspace> | null {
  let out: AnyRow | null = null;
  for (const ev of events) {
    if (ev.entity_type !== "workspace" || !ev.data?.changes) continue;
    out ??= {};
    for (const [field, change] of Object.entries(ev.data.changes)) out[field] = change.to;
  }
  return out;
}

export interface BootstrapData extends Partial<Record<CollectionName, AnyRow[]>> {
  seq: number;
  me: Member;
  user: User;
  workspace: Workspace;
  /** "open" when the answer holds only the open work; `rest` then counts the tasks left out. */
  part?: string;
  rest?: number;
}

/** The second part of the starting copy: the finished tasks and what hangs on them. */
export interface RestData {
  seq: number;
  tasks?: AnyRow[];
  decisions?: AnyRow[];
  attachments?: AnyRow[];
  relations?: AnyRow[];
}

type ReplacedListener = () => void;
const replacedListeners = new Set<ReplacedListener>();

/**
 * Hear when the copy is thrown away: at sign-out, on leaving a workspace,
 * and when the person's access changed. Whatever was fetched outside the
 * store for the old copy (a task's history) must go with it.
 */
export function onReplaced(listener: ReplacedListener): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}

export interface LoadOptions {
  /**
   * Start from nothing: keep no row of the copy before. Used when the
   * person's access changed, so that what they may no longer see is gone.
   */
  fresh?: boolean;
}

/** Replaces the whole copy with a fresh one from the server. */
export function loadBootstrap(slug: string, data: BootstrapData, opts: LoadOptions = {}) {
  const prev = getState();
  const keep = prev.slug === slug && !opts.fresh ? prev : null;
  const c = emptyCollections();
  for (const name of Object.keys(c) as CollectionName[]) {
    const table = c[name] as Dict<AnyRow>;
    for (const row of data[name] ?? []) table[keyOf(name, row)] = normalize(name, row);
  }
  if (keep) {
    // The starting copy leaves out what a task carries once opened; keep it.
    for (const id of Object.keys(keep.opened)) {
      const old = keep.collections.tasks[id];
      const task = c.tasks[id];
      if (old?.description && task) c.tasks[id] = { ...task, description: old.description };
    }
    // Nor what an opened task or page brought: its comments, files and links, a database's properties and views.
    for (const name of ["comments", "attachments", "links", "properties", "dbviews"] as const) {
      Object.assign(c[name], keep.collections[name]);
    }
    // Watchers of opened tasks other than me, and deleted tasks and questions shown in the trash.
    c.watchers = { ...keep.collections.watchers, ...c.watchers };
    for (const task of Object.values(keep.collections.tasks)) {
      if (task.deleted_at && !c.tasks[task.id]) c.tasks[task.id] = task;
    }
    for (const decision of Object.values(keep.collections.decisions)) {
      if (decision.deleted_at && !c.decisions[decision.id]) c.decisions[decision.id] = decision;
    }
    // Rows made here and not yet confirmed are in no answer from the server; they stay on screen.
    for (const [id, name] of Object.entries(keep.drafts)) {
      const table = c[name] as Dict<AnyRow>;
      const row = (keep.collections[name] as Dict<AnyRow>)[id];
      if (row && !table[id]) table[id] = row;
    }
  }
  // The copy read again because the person's access changed: the projects that were here and are not now are lost to them.
  const keys = new Set(Object.values(c.projects).map((p) => p.key));
  const lostProjects = prev.slug === slug ? prev.lostProjects.filter((key) => !keys.has(key)) : [];
  if (opts.fresh && prev.slug === slug) {
    for (const p of Object.values(prev.collections.projects)) {
      if (!p.deleted_at && !keys.has(p.key) && !lostProjects.includes(p.key)) lostProjects.push(p.key);
    }
  }
  useStore.setState({
    slug,
    ready: true,
    seq: data.seq,
    me: data.me,
    user: data.user,
    workspace: data.workspace,
    collections: c,
    opened: keep?.opened ?? {},
    restLoaded: !(data.part === "open" && (data.rest ?? 0) > 0),
    drafts: keep?.drafts ?? {},
    lostProjects,
  });
  if (!keep) for (const listener of replacedListeners) listener();
}

const REST_PARTS = ["tasks", "decisions", "attachments", "relations"] as const;

/**
 * Adds the second part of the starting copy. A row the store already has is
 * left alone unless the arriving one is newer (by `updated_seq`): the feed
 * may have changed it since. `meanwhile` is every event applied since the
 * first part was loaded: those that came after this part was read on the
 * server are applied again, over the rows it brings.
 *
 * Returns the ids of tasks that those events named and that are in neither
 * part (closed when the first was read, open again by the second); the
 * caller fetches those one by one.
 */
export function mergeRest(slug: string, data: RestData, meanwhile: FeedEvent[]): string[] {
  const s = getState();
  if (s.slug !== slug || s.restLoaded) return [];
  const d = new CopyOnWrite(s.collections);
  const added = new Set<string>();
  for (const name of REST_PARTS) {
    for (const row of data[name] ?? []) {
      const key = keyOf(name, row);
      const cur = d.peek(name)[key];
      if (cur) {
        const mine = cur.updated_seq;
        const theirs = row.updated_seq;
        if (!(typeof mine === "number" && typeof theirs === "number" && mine < theirs)) continue;
        // A task opened earlier keeps the description the lists do not carry.
        d.put(name, cur.description && !row.description ? { ...row, description: cur.description } : row);
      } else {
        d.put(name, row);
      }
      added.add(`${name}:${key}`);
    }
  }
  for (const ev of meanwhile) {
    if (ev.seq > data.seq) applyEvent(d, ev, (name, key) => added.has(`${name}:${key}`));
  }
  const next = d.done();
  const missing = new Set<string>();
  for (const ev of meanwhile) {
    const target = targetsOf(ev);
    if (target?.collection !== "tasks" || target.gone) continue;
    for (const id of target.keys) if (!next.tasks[id]) missing.add(id);
  }
  useStore.setState({ collections: next, restLoaded: true });
  return [...missing];
}

/** Marks rows made here as waiting for the server (data/mutate.ts does this for every row an edit inserts). */
export function markDrafts(collection: CollectionName, ids: string[]) {
  if (ids.length === 0) return;
  useStore.setState((s) => {
    const drafts = { ...s.drafts };
    for (const id of ids) drafts[id] = collection;
    return { drafts };
  });
}

/** The server answered (either way) for these rows: they are drafts no longer. */
export function clearDrafts(ids: string[]) {
  const { drafts } = getState();
  if (!ids.some((id) => id in drafts)) return;
  const next = { ...drafts };
  for (const id of ids) delete next[id];
  useStore.setState({ drafts: next });
}

/**
 * Adds or replaces rows fetched outside the feed (an opened task, the trash).
 * A row the feed has moved on since it was read (a change arrived while the
 * fetch was on its way) keeps what the feed gave it; the fetched copy only
 * fills in what the held one does not carry, like a task's description.
 */
export function mergeRows<K extends CollectionName>(name: K, rows: Collections[K][string][]) {
  if (rows.length === 0) return;
  const d = new CopyOnWrite(getState().collections);
  for (const row of rows) {
    const fetched: AnyRow = row;
    const held = d.peek(name)[keyOf(name, fetched)];
    const heldIsNewer =
      typeof held?.updated_seq === "number" &&
      typeof fetched.updated_seq === "number" &&
      held.updated_seq > fetched.updated_seq;
    d.put(name, heldIsNewer ? { ...fetched, ...held } : fetched);
  }
  useStore.setState({ collections: d.done() });
}

export function patchRow(name: CollectionName, id: string, fields: AnyRow) {
  const d = new CopyOnWrite(getState().collections);
  d.patch(name, id, fields);
  useStore.setState({ collections: d.done() });
}

export function removeRow(name: CollectionName, id: string) {
  const d = new CopyOnWrite(getState().collections);
  d.drop(name, id);
  useStore.setState({ collections: d.done() });
}

export function markOpened(taskId: string) {
  useStore.setState((s) => (s.opened[taskId] ? s : { opened: { ...s.opened, [taskId]: true } }));
}

/** Empties the copy: at sign-out, and when the person may no longer see this workspace. */
export function clearStore() {
  useStore.setState({
    slug: "",
    ready: false,
    seq: 0,
    me: null,
    user: null,
    workspace: null,
    collections: emptyCollections(),
    opened: {},
    stream: "connecting",
    restLoaded: false,
    drafts: {},
    lostProjects: [],
  });
  for (const listener of replacedListeners) listener();
}

export { keyOf };

// The copy lives in this module; hot-swapping it in development would leave
// two copies, one fed by the stream and one read by the pages. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

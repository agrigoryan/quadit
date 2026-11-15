// The browser's copy of one workspace: every row, in collections keyed by
// id. It is filled from /bootstrap (the open work first, the finished work a
// moment later) and then kept current by the event feed (lib/sync.ts) and by
// the person's own edits (lib/mutate.ts). Pages read from here and never ask
// the server for a list.

import { create } from "zustand";
import { type AnyRow, applyEvent, Draft, emptyCollections, keyOf, normalize, targetsOf } from "@/lib/apply";
import type {
  AgentSession,
  Attachment,
  Comment,
  Cycle,
  Decision,
  Epic,
  FeedEvent,
  Label,
  Member,
  Milestone,
  Notification,
  Project,
  Relation,
  Secret,
  Status,
  Task,
  TaskLink,
  Template,
  User,
  View,
  Watcher,
  Workspace,
} from "@/lib/types";

export type Dict<T> = Record<string, T>;

export interface Collections {
  tasks: Dict<Task>;
  comments: Dict<Comment>;
  decisions: Dict<Decision>;
  projects: Dict<Project>;
  statuses: Dict<Status>;
  labels: Dict<Label>;
  members: Dict<Member>;
  epics: Dict<Epic>;
  milestones: Dict<Milestone>;
  cycles: Dict<Cycle>;
  views: Dict<View>;
  templates: Dict<Template>;
  preferences: Dict<AnyRow>;
  attachments: Dict<Attachment>;
  relations: Dict<Relation>;
  links: Dict<TaskLink>;
  notifications: Dict<Notification>;
  watchers: Dict<Watcher>;
  sessions: Dict<AgentSession>;
  resources: Dict<AnyRow>;
  claims: Dict<AnyRow>;
  docs: Dict<AnyRow>;
  blocks: Dict<AnyRow>;
  webhooks: Dict<AnyRow>;
  rules: Dict<AnyRow>;
  integrations: Dict<AnyRow>;
  /** Not in the starting copy: the secrets page fetches them (settings/secrets/data.ts). */
  secrets: Dict<Secret>;
}

export type CollectionName = keyof Collections;

export type StreamState = "connecting" | "live" | "down";

export interface StoreState {
  slug: string;
  ready: boolean;
  /** The last feed position applied from the live stream, in order. */
  seq: number;
  me: Member | null;
  user: User | null;
  workspace: Workspace | null;
  c: Collections;
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
  c: emptyCollections(),
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

/** False until the finished work has arrived (see StoreState.restLoaded). */
export const useRestLoaded = (): boolean => useStore((s) => s.restLoaded);

type EventListener = (events: FeedEvent[]) => void;
const listeners = new Set<EventListener>();

/** Hear every event the store applies (a task's timeline follows along this way). */
export function onEvents(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Events applied while the finished work was still on its way; replayed over it when it lands. */
let held: FeedEvent[] = [];
/** Past this many held events the second part is not worth patching: the whole copy is fetched again. */
const HELD_MAX = 20_000;

/**
 * Applies feed events. Events from the live stream arrive in order and move
 * `seq`; events returned by a write are applied early and do not, because
 * the stream will deliver them again in their place.
 */
export function applyEvents(events: FeedEvent[], fromStream: boolean) {
  const { seq, c, drafts, restLoaded } = getState();
  const fresh = events.filter((ev) => ev.seq > seq);
  if (fresh.length === 0) return;
  const d = new Draft(c);
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
  // Past the limit nothing more is held: mergeRest then asks for the whole copy again.
  if (!restLoaded && held.length <= HELD_MAX) held.push(...fresh);
  const workspacePatch = workspaceChanges(fresh);
  const next = d.done();
  useStore.setState((s) => ({
    c: next,
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

/** Hear the events this tab's own accepted changes came back with (lib/sync.ts passes them to the other tabs). */
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
  return out as Partial<Workspace> | null;
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
      const old = keep.c.tasks[id];
      const task = c.tasks[id];
      if (old?.description && task) c.tasks[id] = { ...task, description: old.description };
    }
    for (const name of ["comments", "attachments", "links"] as const) {
      Object.assign(c[name], keep.c[name]);
    }
    // Watchers of opened tasks other than me, and deleted tasks and questions shown in the trash.
    c.watchers = { ...keep.c.watchers, ...c.watchers };
    for (const task of Object.values(keep.c.tasks)) {
      if (task.deleted_at && !c.tasks[task.id]) c.tasks[task.id] = task;
    }
    for (const decision of Object.values(keep.c.decisions)) {
      if (decision.deleted_at && !c.decisions[decision.id]) c.decisions[decision.id] = decision;
    }
    // Rows made here and not yet confirmed are in no answer from the server; they stay on screen.
    for (const [id, name] of Object.entries(keep.drafts)) {
      const table = c[name] as Dict<AnyRow>;
      const row = (keep.c[name] as Dict<AnyRow>)[id];
      if (row && !table[id]) table[id] = row;
    }
  }
  // The copy read again because the person's access changed: the projects that were here and are not now are lost to them.
  const keys = new Set(Object.values(c.projects).map((p) => p.key));
  const lostProjects = prev.slug === slug ? prev.lostProjects.filter((key) => !keys.has(key)) : [];
  if (opts.fresh && prev.slug === slug) {
    for (const p of Object.values(prev.c.projects)) {
      if (!p.deleted_at && !keys.has(p.key) && !lostProjects.includes(p.key)) lostProjects.push(p.key);
    }
  }
  held = [];
  useStore.setState({
    slug,
    ready: true,
    seq: data.seq,
    me: data.me,
    user: data.user,
    workspace: data.workspace,
    c,
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
 * may have changed it since. Events that came in after this part was read on
 * the server are applied again over the rows it brings.
 *
 * Returns the ids of tasks that events named meanwhile and that are in
 * neither part (closed when the first was read, open again by the second);
 * the caller fetches those one by one. Returns null when too much happened
 * to patch: the caller then fetches the whole copy again.
 */
export function mergeRest(slug: string, data: RestData): string[] | null {
  const s = getState();
  if (s.slug !== slug || s.restLoaded) return [];
  if (held.length > HELD_MAX) {
    held = [];
    return null;
  }
  const d = new Draft(s.c);
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
  const late = held;
  held = [];
  for (const ev of late) {
    if (ev.seq > data.seq) applyEvent(d, ev, (name, key) => added.has(`${name}:${key}`));
  }
  const next = d.done();
  const missing = new Set<string>();
  for (const ev of late) {
    const target = targetsOf(ev);
    if (target?.collection !== "tasks" || target.gone) continue;
    for (const id of target.keys) if (!next.tasks[id]) missing.add(id);
  }
  useStore.setState({ c: next, restLoaded: true });
  // A mark for the server's picture-taking browser: the page has its data.
  document.documentElement.dataset.loaded = "1";
  return [...missing];
}

/** Marks rows made here as waiting for the server (lib/mutate.ts does this for every row an edit inserts). */
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

/** Adds or replaces rows fetched outside the feed (an opened task, the trash). */
export function mergeRows<K extends CollectionName>(name: K, rows: Collections[K][string][]) {
  if (rows.length === 0) return;
  const d = new Draft(getState().c);
  for (const row of rows) d.put(name, row as unknown as AnyRow);
  useStore.setState({ c: d.done() });
}

export function patchRow(name: CollectionName, id: string, fields: AnyRow) {
  const d = new Draft(getState().c);
  d.patch(name, id, fields);
  useStore.setState({ c: d.done() });
}

export function removeRow(name: CollectionName, id: string) {
  const d = new Draft(getState().c);
  d.drop(name, id);
  useStore.setState({ c: d.done() });
}

export function markOpened(taskId: string) {
  useStore.setState((s) => (s.opened[taskId] ? s : { opened: { ...s.opened, [taskId]: true } }));
}

/** Empties the copy: at sign-out, and when the person may no longer see this workspace. */
export function clearStore() {
  held = [];
  useStore.setState({
    slug: "",
    ready: false,
    seq: 0,
    me: null,
    user: null,
    workspace: null,
    c: emptyCollections(),
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

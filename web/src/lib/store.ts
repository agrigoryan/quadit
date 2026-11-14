// The browser's copy of one workspace: every row, in collections keyed by
// id. It is filled once from /bootstrap and then kept current by the event
// feed (lib/sync.ts) and by the person's own edits (lib/mutate.ts). Pages
// read from here and never ask the server for a list.

import { create } from "zustand";
import { type AnyRow, applyEvent, Draft, emptyCollections, keyOf, normalize } from "@/lib/apply";
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
}));

export const getState = useStore.getState;

type EventListener = (events: FeedEvent[]) => void;
const listeners = new Set<EventListener>();

/** Hear every event the store applies (a task's timeline follows along this way). */
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
  const { seq, c } = getState();
  const fresh = events.filter((ev) => ev.seq > seq);
  if (fresh.length === 0) return;
  const d = new Draft(c);
  let last = seq;
  for (const ev of fresh) {
    if (ev.entity_type === "workspace" && ev.data?.changes) continue;
    applyEvent(d, ev);
    last = Math.max(last, ev.seq);
  }
  const workspacePatch = workspaceChanges(fresh);
  const next = d.done();
  useStore.setState((s) => ({
    c: next,
    // The signed-in member is a row like any other: follow its role, name and avatar.
    me: (s.me && next.members[s.me.user_id]) || s.me,
    seq: fromStream ? last : s.seq,
    workspace: s.workspace && workspacePatch ? { ...s.workspace, ...workspacePatch } : s.workspace,
  }));
  for (const listener of listeners) listener(fresh);
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
}

/** Replaces the whole copy with a fresh one from the server. */
export function loadBootstrap(slug: string, data: BootstrapData) {
  const prev = getState();
  const keep = prev.slug === slug ? prev : null;
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
    // Watchers of opened tasks other than me, and deleted tasks shown in the trash.
    c.watchers = { ...keep.c.watchers, ...c.watchers };
    for (const task of Object.values(keep.c.tasks)) {
      if (task.deleted_at && !c.tasks[task.id]) c.tasks[task.id] = task;
    }
  }
  useStore.setState({
    slug,
    ready: true,
    seq: data.seq,
    me: data.me,
    user: data.user,
    workspace: data.workspace,
    c,
    opened: keep?.opened ?? {},
  });
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

export function clearStore() {
  useStore.setState({ slug: "", ready: false, seq: 0, me: null, user: null, workspace: null, c: emptyCollections(), opened: {} });
}

export { keyOf };

// The copy lives in this module; hot-swapping it in development would leave
// two copies, one fed by the stream and one read by the pages. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

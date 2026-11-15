// Every edit goes through mutate(): the change shows at once, is sent to the
// server as a named change, and is undone if the server refuses it.
//
//   mutate({ type: "task.update", args: { id, priority: 1 } },
//          (tx) => tx.patch("tasks", id, { priority: 1 }));
//
// Changes leave in the order they were made, one request at a time. If the
// server cannot be reached the change waits and is sent again with the same
// change id, which the server uses to apply it only once.
//
// Waiting changes are also kept on the device (lib/outbox.ts), so a reload
// or a closed tab does not lose them: the next page of the same workspace
// takes them over and sends them, in order, before anything new. A change
// taken over this way has nothing on screen to undo; if the server refuses
// it, a note says what was not saved.

import { api, ApiError, errorMessage, NetworkError, workspacePath } from "@/lib/api";
import type { Changes } from "@/lib/changes.gen";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { outbox, type OutboxChange } from "@/lib/outbox";
import {
  applyOwnEvents,
  clearDrafts,
  type CollectionName,
  getState,
  keyOf,
  markDrafts,
  mergeRows,
  patchRow,
  removeRow,
  useStore,
} from "@/lib/store";
import { toast } from "@/lib/toast";
import type { ChangeResult } from "@/lib/types";

type Row = Record<string, unknown>;

export type ChangeType = keyof Changes;

/**
 * One change: its name and the arguments the server takes for it (generated
 * from the engine, see lib/changes.gen.ts), so a misspelt name or argument
 * fails the type check, not the request.
 */
export type ChangeSpec<K extends ChangeType = ChangeType> = {
  [P in K]: {
    type: P;
    args: Changes[P];
    /** The change id, when the caller needs to recognise its own events in the feed. Made here when left out. */
    id?: string;
  };
}[K];

/** What an edit does to the local copy before the server answers. */
export interface Tx {
  /** Sets fields on a row; null clears a field. */
  patch(collection: CollectionName, id: string, fields: Row): void;
  insert(collection: CollectionName, row: Row): void;
  remove(collection: CollectionName, id: string): void;
}

type Undo = () => void;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function optimisticTx(undos: Undo[], made: string[]): Tx {
  const table = (name: CollectionName) => getState().collections[name] as Record<string, Row>;
  return {
    patch(collection, id, fields) {
      const cur = table(collection)[id];
      if (!cur) return;
      const before: Row = {};
      for (const field of Object.keys(fields)) before[field] = cur[field] ?? null;
      patchRow(collection, id, fields);
      undos.push(() => {
        // Put back only what is still as this edit left it: a newer event wins.
        const now = table(collection)[id];
        if (!now) return;
        const restore: Row = {};
        for (const field of Object.keys(fields)) {
          if (same(now[field], fields[field])) restore[field] = before[field];
        }
        patchRow(collection, id, restore);
      });
    },
    insert(collection, row) {
      const id = keyOf(collection, row);
      mergeRows(collection, [row as never]);
      // Until the server answers the row is a draft (store.isDraft): a new task has no number yet.
      markDrafts(collection, [id]);
      made.push(id);
      undos.push(() => removeRow(collection, id));
    },
    remove(collection, id) {
      const cur = table(collection)[id];
      if (!cur) return;
      removeRow(collection, id);
      undos.push(() => {
        if (!table(collection)[id]) mergeRows(collection, [cur as never]);
      });
    },
  };
}

interface Job {
  /** Its place in the queue and its name in the outbox. */
  key: string;
  /** The workspace it was made in; it is sent there wherever the person is by then. */
  slug: string;
  body: { changes: OutboxChange[] };
  undos: Undo[];
  /** Rows the edit inserted: drafts until the server answers. */
  made: string[];
  quiet: boolean;
  /** What to call it in a note. */
  what: string;
  /** Taken over from an earlier page: nobody waits for the answer and nothing is on screen to undo. */
  restored: boolean;
  resolve: (results: ChangeResult[]) => void;
  reject: (err: unknown) => void;
}

const queue: Job[] = [];
let pumping = false;
let wake: (() => void) | null = null;

if (typeof window !== "undefined") window.addEventListener("online", () => wake?.());
// The live stream coming back is the surest sign the server can be reached again.
useStore.subscribe((s, prev) => {
  if (s.stream === "live" && prev.stream !== "live") wake?.();
});

const countUnsent = () => useStore.setState({ unsent: queue.length });

/** Waits before a retry; coming back online ends the wait early. */
function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  let attempt = 0;
  while (queue.length > 0) {
    const job = queue[0] as Job;
    try {
      const out = await api.post<{ results: ChangeResult[] }>(workspacePath(job.slug, "/changes?events=1"), job.body);
      // The queue was emptied while this was on its way (sign-out): nothing more to do with it.
      if (queue[0] !== job) continue;
      queue.shift();
      outbox.remove(job.key);
      attempt = 0;
      useStore.setState({ offline: false, unsent: queue.length });
      applyOwnEvents(
        job.slug,
        out.results.flatMap((r) => r.events ?? []),
      );
      clearDrafts(job.made);
      job.resolve(out.results);
    } catch (err) {
      if (queue[0] !== job) continue;
      if (err instanceof NetworkError) {
        // Not refused, just not delivered: keep it and try again.
        useStore.setState({ offline: true });
        attempt++;
        await pause(Math.min(1000 * 2 ** Math.min(attempt, 4), 15_000));
        continue;
      }
      if (err instanceof ApiError && err.status === 401) {
        // The session ended; nothing was refused. What is kept on the device
        // is sent after the same person signs in again.
        forgetQueue(err);
        break;
      }
      queue.shift();
      outbox.remove(job.key);
      attempt = 0;
      countUnsent();
      for (const undo of job.undos.reverse()) undo();
      clearDrafts(job.made);
      if (job.restored) toast.error(t("sync.refused", { what: job.what, reason: errorMessage(err) }));
      else if (!job.quiet) toast.error(errorMessage(err));
      job.reject(err);
    }
  }
  pumping = false;
}

/** Empties the queue in memory. What is kept on the device stays there. */
function forgetQueue(reason: unknown) {
  const jobs = queue.splice(0);
  useStore.setState({ unsent: 0, offline: false });
  for (const job of jobs) {
    clearDrafts(job.made);
    job.reject(reason);
  }
  wake?.();
}

/**
 * Forgets every change not yet sent, in memory and on the device. Called at
 * sign-out: what one person left unsent is not sent by the next.
 */
export function clearOutbox(): Promise<void> {
  forgetQueue(new Error("signed out"));
  return outbox.clear();
}

/**
 * Takes over the changes an earlier page of this workspace left unsent (it
 * was reloaded or closed before the server could be reached) and sends them
 * first, in the order they were made. Called once the workspace has loaded.
 */
export async function restoreQueue(slug: string): Promise<void> {
  const user = getState().me?.user_id;
  if (!user || getState().slug !== slug) return;
  const items = await outbox.adopt(slug, user);
  if (items.length === 0) return;
  const jobs = items.map((item): Job => ({
    key: item.key,
    slug: item.slug,
    body: { changes: item.changes },
    undos: [],
    made: [],
    quiet: false,
    what: item.what,
    restored: true,
    resolve: () => {},
    reject: () => {},
  }));
  // Older than anything made on this page, but never ahead of a request already on its way.
  queue.splice(pumping && queue.length > 0 ? 1 : 0, 0, ...jobs);
  countUnsent();
  void pump();
}

/** A few words for a change, for the note shown if it cannot be saved after a reload. */
function describe(changes: OutboxChange[]): string {
  const first = changes[0] as OutboxChange;
  const { tasks } = getState().collections;
  const args: Row = first.args;
  const ref = [args.task, args.id].find((v): v is string => typeof v === "string" && v in tasks);
  const key = ref ? tasks[ref]?.key : undefined;
  let what: string;
  if (first.type === "task.create") what = t("sync.what.newTask", { title: first.args.title ?? "" });
  else if (key && first.type.startsWith("task.")) what = t("sync.what.task", { key });
  else if (key && first.type.startsWith("comment.")) what = t("sync.what.comment", { key });
  else if (key && first.type.startsWith("attachment.")) what = t("sync.what.file", { key });
  else what = t("sync.what.other", { type: first.type });
  return changes.length > 1 ? t("sync.what.more", { what, n: changes.length - 1 }) : what;
}

export interface MutateOptions {
  /** Do not show a toast if the server refuses; the caller shows the error itself. */
  quiet?: boolean;
}

/**
 * Makes one change, or several as one all-or-nothing batch. Resolves with
 * the server's results; rejects (after undoing the optimistic update and
 * showing the server's message) if the change is refused.
 */
export function mutate<K extends ChangeType>(
  changes: ChangeSpec<K> | ChangeSpec<K>[],
  optimistic?: (tx: Tx) => void,
  opts?: MutateOptions,
): Promise<ChangeResult[]>;
export function mutate(
  changes: ChangeSpec | ChangeSpec[],
  optimistic?: (tx: Tx) => void,
  opts: MutateOptions = {},
): Promise<ChangeResult[]> {
  const list = Array.isArray(changes) ? changes : [changes];
  if (list.length === 0) return Promise.resolve([]);
  const { slug, me } = getState();
  const body = { changes: list.map((c): OutboxChange => ({ ...c, id: c.id ?? newId() })) };
  // Named before the edit shows, while the rows still read as the person saw them.
  const what = describe(body.changes);
  const undos: Undo[] = [];
  const made: string[] = [];
  optimistic?.(optimisticTx(undos, made));
  const key = outbox.newKey();
  if (me) outbox.put({ key, slug, user: me.user_id, changes: body.changes, what, at: Date.now() });
  return new Promise((resolve, reject) => {
    queue.push({ key, slug, body, undos, made, quiet: opts.quiet ?? false, what, restored: false, resolve, reject });
    countUnsent();
    void pump();
  });
}

/** mutate() for callers that do not need the result: a refusal is already shown. */
export function send<K extends ChangeType>(
  changes: ChangeSpec<K> | ChangeSpec<K>[],
  optimistic?: (tx: Tx) => void,
): void {
  mutate(changes, optimistic).catch(() => {});
}

// The queue lives in this module; hot-swapping it in development would
// strand the changes waiting in the old one. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

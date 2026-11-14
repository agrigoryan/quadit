// Every edit goes through mutate(): the change shows at once, is sent to the
// server as a named change, and is undone if the server refuses it.
//
//   mutate({ type: "task.update", args: { id, priority: 1 } },
//          (tx) => tx.patch("tasks", id, { priority: 1 }));
//
// Changes leave in the order they were made, one request at a time. If the
// server cannot be reached the change waits and is sent again with the same
// change id, which the server uses to apply it only once.

import { api, ApiError, errorMessage, NetworkError, ws } from "@/lib/api";
import { newId } from "@/lib/ids";
import { applyEvents, type CollectionName, getState, keyOf, mergeRows, patchRow, removeRow, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { ChangeResult } from "@/lib/types";

type Row = Record<string, unknown>;

export interface ChangeSpec {
  type: string;
  args: Row;
}

/** What an edit does to the local copy before the server answers. */
export interface Tx {
  /** Sets fields on a row; null clears a field. */
  patch(collection: CollectionName, id: string, fields: Row): void;
  insert(collection: CollectionName, row: Row): void;
  remove(collection: CollectionName, id: string): void;
}

type Undo = () => void;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function optimisticTx(undos: Undo[]): Tx {
  const table = (name: CollectionName) => getState().c[name] as Record<string, Row>;
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
  body: { changes: { id: string; type: string; args: Row }[] };
  undos: Undo[];
  quiet: boolean;
  resolve: (results: ChangeResult[]) => void;
  reject: (err: unknown) => void;
}

const queue: Job[] = [];
let pumping = false;
let wake: (() => void) | null = null;

if (typeof window !== "undefined") window.addEventListener("online", () => wake?.());

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
    const slug = getState().slug;
    try {
      const out = await api.post<{ results: ChangeResult[] }>(ws(slug, "/changes?events=1"), job.body);
      queue.shift();
      attempt = 0;
      useStore.setState({ offline: false, unsent: queue.length });
      applyEvents(out.results.flatMap((r) => r.events ?? []), false);
      job.resolve(out.results);
    } catch (err) {
      if (err instanceof NetworkError) {
        // Not refused, just not delivered: keep it and try again.
        useStore.setState({ offline: true });
        attempt++;
        await pause(Math.min(1000 * 2 ** Math.min(attempt, 4), 15_000));
        continue;
      }
      queue.shift();
      attempt = 0;
      countUnsent();
      for (const undo of job.undos.reverse()) undo();
      if (!job.quiet && !(err instanceof ApiError && err.status === 401)) toast.error(errorMessage(err));
      job.reject(err);
    }
  }
  pumping = false;
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
export function mutate(
  changes: ChangeSpec | ChangeSpec[],
  optimistic?: (tx: Tx) => void,
  opts: MutateOptions = {},
): Promise<ChangeResult[]> {
  const list = Array.isArray(changes) ? changes : [changes];
  if (list.length === 0) return Promise.resolve([]);
  const undos: Undo[] = [];
  optimistic?.(optimisticTx(undos));
  return new Promise((resolve, reject) => {
    queue.push({
      body: { changes: list.map((c) => ({ id: newId(), type: c.type, args: c.args })) },
      undos,
      quiet: opts.quiet ?? false,
      resolve,
      reject,
    });
    countUnsent();
    void pump();
  });
}

/** mutate() for callers that do not need the result: a refusal is already shown. */
export function send(changes: ChangeSpec | ChangeSpec[], optimistic?: (tx: Tx) => void): void {
  mutate(changes, optimistic).catch(() => {});
}

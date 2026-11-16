// Undo and redo (Cmd+Z, Shift+Cmd+Z): what the person did on this page,
// newest last, each with the change that takes it back.
//
// Nothing is held back to make undo possible: an edit is sent when it is
// made (data/mutate.ts), and undoing it sends a second, opposite change the
// same way, so it is saved, shown to everyone and kept in the history like
// any other. The opposite is worked out when the edit is made, from the
// rows as they stood then: undo puts back what the person saw, whatever
// anyone changed since.
//
// An edit is remembered only where its action says how to take it back
// (sendUndoable, or remember for an action that is more than one batch).
// The memory is this tab's: a reload starts it empty, and it holds the last
// hundred. Making a new edit forgets what was undone.

import { create } from "zustand";
import { t } from "@/lib/i18n";
import { type ChangeSpec, mutate, type Tx } from "@/data/mutate";
import { getState } from "@/data/store";
import { toast } from "@/lib/toast";

/** How many edits are remembered; the oldest is forgotten first. */
const DEPTH = 100;

/** One batch of changes and what it shows ahead of the server's answer: the arguments of mutate(). */
export interface Batch {
  changes: ChangeSpec[];
  show?: (tx: Tx) => void;
}

/** Something done that can be taken back. */
export interface Done {
  /** What was done, as the rest of a sentence: "change the status of SVA-12". */
  name: string;
  /** When, in milliseconds. */
  at: number;
  /** The workspace it was done in: it is not undone from another. */
  slug: string;
  /** Sends the change that takes it back. Rejects if the server refuses. */
  undo(): Promise<unknown>;
  /** Sends the change that does it again. */
  redo(): Promise<unknown>;
}

interface Memory {
  /** What can be undone, newest last. */
  done: Done[];
  /** What was undone and can be done again, newest last. */
  undone: Done[];
}

/** The memory, for what shows it (the palette names the next thing to undo). */
export const useUndo = create<Memory>(() => ({ done: [], undone: [] }));

const without = (list: Done[], entry: Done) => list.filter((d) => d !== entry);

/** The newest entry of this workspace; entries of a workspace left behind are dropped on the way. */
function newest(stack: keyof Memory): Done | undefined {
  const { slug } = getState();
  const list = useUndo.getState()[stack];
  const mine = list.filter((d) => d.slug === slug);
  if (mine.length !== list.length) useUndo.setState({ [stack]: mine } as Pick<Memory, typeof stack>);
  return mine.at(-1);
}

/** What Cmd+Z would undo now, if anything. */
export const nextUndo = () => newest("done");
/** What Shift+Cmd+Z would do again now, if anything. */
export const nextRedo = () => newest("undone");

/**
 * Remembers something just done, with the two ways across it. What was
 * undone before is forgotten: there is one line of history, not a tree.
 */
export function remember(name: string, undo: Done["undo"], redo: Done["redo"]): Done {
  const entry: Done = { name, at: Date.now(), slug: getState().slug, undo, redo };
  useUndo.setState((s) => ({ done: [...s.done, entry].slice(-DEPTH), undone: [] }));
  return entry;
}

/** Forgets an entry: the server refused what it stands for, so there is nothing to take back. */
export function forget(entry: Done) {
  useUndo.setState((s) => ({ done: without(s.done, entry), undone: without(s.undone, entry) }));
}

/**
 * Sends `forward` now and remembers it with `back`, the batch that takes it
 * back. A refusal is shown by mutate() and the edit is forgotten.
 */
export function sendUndoable(name: string, forward: Batch, back: Batch): Done {
  const run = (batch: Batch) => mutate(batch.changes, batch.show);
  const entry = remember(
    name,
    () => run(back),
    () => run(forward),
  );
  run(forward).catch(() => forget(entry));
  return entry;
}

/**
 * Takes back the newest thing done, or `entry` when it is given and still
 * there to undo (a note's own Undo button). False when there is nothing.
 */
export function undo(entry = nextUndo()): boolean {
  if (!entry || entry.slug !== getState().slug || !useUndo.getState().done.includes(entry)) return false;
  useUndo.setState((s) => ({ done: without(s.done, entry), undone: [...s.undone, entry] }));
  toast.info(t("undo.undone", { name: entry.name }));
  // Refused (the task is gone, the right to change it was taken away): mutate() has said so, and there is nothing to redo.
  entry.undo().catch(() => forget(entry));
  return true;
}

/** Does the newest undone thing again. False when there is nothing. */
export function redo(): boolean {
  const entry = nextRedo();
  if (!entry) return false;
  useUndo.setState((s) => ({ done: [...s.done, entry], undone: without(s.undone, entry) }));
  toast.info(t("undo.redone", { name: entry.name }));
  entry.redo().catch(() => forget(entry));
  return true;
}

/** Empties the memory: at sign-out, what one person did is not the next one's to undo. */
export function clearUndo() {
  useUndo.setState({ done: [], undone: [] });
}

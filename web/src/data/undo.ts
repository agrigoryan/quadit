// Undo and redo (Cmd+Z, Shift+Cmd+Z): what the person did on this page,
// newest last, each with the change that takes it back.
//
// Nothing is held back to make undo possible: an edit is sent when it is
// made (data/mutate.ts), and undoing it sends a second, opposite change the
// same way, so it is saved, shown to everyone and kept in the history like
// any other. That change names the one it takes back, so the server can
// spare people the news of a mistake put right at once. The opposite is worked out when the edit is made, from the
// rows as they stood then: undo puts back what the person saw, whatever
// anyone changed since.
//
// An edit is remembered only where its action says how to take it back
// (sendUndoable, or remember for an action that is more than one batch).
// The memory is this tab's: a reload starts it empty, and it holds the last
// hundred. Making a new edit forgets what was undone.
//
// Two kinds of undo are asked about first (askToUndo): something done more
// than five minutes ago, so a stray Cmd+Z does not quietly change what was
// settled a while back, and something whose undoing loses more than it
// made (a task just created goes to the trash with whatever was added to
// it since).

import { create } from "zustand";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, type Tx } from "@/data/mutate";
import { getState } from "@/data/store";
import { toast } from "@/lib/toast";

/** How many edits are remembered; the oldest is forgotten first. */
const DEPTH = 100;
/** Older than this, an edit is asked about before it is undone. */
const ASK_AFTER_MS = 5 * 60_000;
/** An edit that goes on from the one before within this time is the same step (see Remembered.sameAs). */
const SAME_STEP_MS = 10_000;

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
  undo: () => Promise<unknown>;
  /** Sends the change that does it again. */
  redo: () => Promise<unknown>;
  /** What undoing it costs, when that is more than the edit itself: said before it is undone. */
  warning?: string;
  /** See Remembered.sameAs. */
  sameAs?: string;
}

/** What an action may say about the step it remembers. */
export interface Remembered {
  /** What undoing it costs, when that is more than the edit itself: the person is asked first. */
  warning?: string;
  /**
   * Edits that go on from one another carry the same word here (a title
   * saved every half second as it is typed): made within ten seconds of
   * the one before, an edit joins it, and the one step goes back to before
   * the first.
   */
  sameAs?: string;
}

interface Memory {
  /** What can be undone, newest last. */
  done: Done[];
  /** What was undone and can be done again, newest last. */
  undone: Done[];
  /** The step the person is being asked about before it is undone. */
  asking: Done | null;
}

/** The memory, for what shows it: the palette names the next thing to undo, the shell asks about `asking`. */
export const useUndo = create<Memory>(() => ({ done: [], undone: [], asking: null }));

type Stack = "done" | "undone";

const without = (list: Done[], entry: Done) => list.filter((d) => d !== entry);

/** The newest entry of this workspace; entries of a workspace left behind are dropped on the way. */
function newest(stack: Stack): Done | undefined {
  const { slug } = getState();
  const list = useUndo.getState()[stack];
  const mine = list.filter((d) => d.slug === slug);
  if (mine.length !== list.length) useUndo.setState({ [stack]: mine } as Pick<Memory, Stack>);
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
export function remember(name: string, undo: Done["undo"], redo: Done["redo"], about: Remembered = {}): Done {
  const entry: Done = { name, at: Date.now(), slug: getState().slug, undo, redo, ...about };
  const before = useUndo.getState().done.at(-1);
  const joins =
    before &&
    entry.sameAs &&
    before.sameAs === entry.sameAs &&
    before.slug === entry.slug &&
    entry.at - before.at < SAME_STEP_MS;
  // Joined, the step still goes back to before the first edit, and forward to the last.
  if (joins) entry.undo = before.undo;
  useUndo.setState((s) => ({ done: [...(joins ? s.done.slice(0, -1) : s.done), entry].slice(-DEPTH), undone: [] }));
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
export function sendUndoable(name: string, forward: Batch, back: Batch, about?: Remembered): Done {
  /** The ids the edit's changes were last sent under. */
  let sentAs: string[] = [];
  const there = () => {
    sentAs = forward.changes.map(() => newId());
    return mutate(
      forward.changes.map((change, i) => ({ ...change, id: sentAs[i] })),
      forward.show,
    );
  };
  // Each change on the way back takes back the one in its place; where the way back is longer, the rest take back the last.
  const andBack = () =>
    mutate(
      back.changes.map((change, i) => ({ ...change, undoes: sentAs[Math.min(i, sentAs.length - 1)] })),
      back.show,
    );
  const entry = remember(name, andBack, there, about);
  there().catch(() => forget(entry));
  return entry;
}

/**
 * Takes back the newest thing done, or `entry` when it is given and still
 * there to undo (a note's own Undo button). False when there is nothing.
 */
export function undo(entry = nextUndo()): boolean {
  if (!entry || entry.slug !== getState().slug || !useUndo.getState().done.includes(entry)) return false;
  useUndo.setState((s) => ({ done: without(s.done, entry), undone: [...s.undone, entry], asking: null }));
  toast.info(t("undo.undone", { name: entry.name }));
  // Refused (the task is gone, the right to change it was taken away): mutate() has said so, and there is nothing to redo.
  entry.undo().catch(() => forget(entry));
  return true;
}

/**
 * Cmd+Z: undoes the newest thing done, asking first where undo.ts says it
 * should (the shell shows the question, and undo(entry) is its yes). False
 * when there is nothing to undo.
 */
export function askToUndo(): boolean {
  const entry = nextUndo();
  if (!entry) return false;
  if (entry.warning || Date.now() - entry.at > ASK_AFTER_MS) useUndo.setState({ asking: entry });
  else undo(entry);
  return true;
}

/** The answer to the question was no, or it was put away. */
export function stopAsking() {
  useUndo.setState({ asking: null });
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
  useUndo.setState({ done: [], undone: [], asking: null });
}

// The list a task's page was opened from, in that list's order, so that J
// and K on the page go to the next and previous task of it. The list on
// screen says its order here; when a page is opened from it, the order is
// kept under the list's step of the browser's history, and the page's own
// step carries that step's name as `from`. Kept in the tab's storage, so a
// reload of the page still knows its list. A page opened by its address
// has no list, and no next or previous.

import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

const QUEUES = "quadit.queues";
const SEEN = "quadit.seen";
/** The lists a person is likely to still be stepping through. */
const KEPT = 6;

function stored<Value>(name: string): [string, Value][] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(name) ?? "[]");
    return Array.isArray(kept) ? (kept as [string, Value][]) : [];
  } catch {
    return []; // storage turned off, or not ours: start with nothing kept
  }
}

function store(name: string, kept: Map<string, unknown>) {
  try {
    sessionStorage.setItem(name, JSON.stringify([...kept]));
  } catch {
    // Private mode or a full store: it lasts until the page is reloaded.
  }
}

const queues = new Map<string, string[]>(stored(QUEUES));
/** The list on screen now: its step, and how to ask it for its order. */
let current: { step: string; order: () => (string | undefined)[] } | null = null;
/** The task last looked at from a list, for the list to put its focus on when it is come back to. */
const seen = new Map<string, string>(stored(SEEN));

/** Says the order of the tasks listed on this page, for as long as it is on screen. Returns its step of the history. */
export function useTaskOrder(order: () => (string | undefined)[]): string {
  const step = useLocation().key;
  const latest = useRef(order);
  latest.current = order;
  useEffect(() => {
    const mine = { step, order: () => latest.current() };
    current = mine;
    return () => {
      if (current === mine) current = null;
    };
  }, [step]);
  return step;
}

/** A task's page is about to open from the list on screen: keeps the list's order, and returns the name to find it by. */
export function leaveForPage(): string | undefined {
  if (!current) return undefined;
  // Grouped by label, or asked about twice, a task can be listed more than once: it is one stop.
  const keys = [...new Set(current.order().filter((key): key is string => !!key))];
  queues.delete(current.step);
  queues.set(current.step, keys);
  while (queues.size > KEPT) queues.delete(queues.keys().next().value as string);
  store(QUEUES, queues);
  return current.step;
}

/** The step of the list a task's page was opened from, as its link's state carries it. */
export const cameFrom = (state: unknown): string | undefined => (state as { from?: string } | null)?.from;

/** Where a task stands in the list its page was opened from; undefined when it came from no list, or is not in it. */
export function placeInQueue(from: string | undefined, taskKey: string): { at: number; keys: string[] } | undefined {
  const keys = from ? queues.get(from) : undefined;
  const at = keys ? keys.indexOf(taskKey) : -1;
  return keys && at >= 0 ? { at, keys } : undefined;
}

/** The page moved on to another task of the list: the list will put its focus there. */
export function markSeen(from: string, taskKey: string) {
  seen.set(from, taskKey);
  store(SEEN, seen);
}

/** The task last looked at from the list at this step, once. */
export function takeSeen(step: string): string | undefined {
  const key = seen.get(step);
  if (seen.delete(step)) store(SEEN, seen);
  return key;
}

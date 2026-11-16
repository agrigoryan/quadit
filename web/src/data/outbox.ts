// The changes not yet sent, kept on the device so that a reload or a closed
// tab does not lose them. data/mutate.ts writes here as changes are made and
// removes them as the server answers; on start it takes over what an earlier
// page left behind.
//
// A page that reloads or closes a moment after a change cannot count on
// IndexedDB: a write the page has not finished when it goes is dropped with
// it. So what this tab holds is also copied to localStorage, which is
// written at once, with every change; the next page takes from there too.
//
// Everything here is best effort: where the browser has no IndexedDB or
// localStorage (or refuses them, as some private windows do) the calls
// quietly do without, and with neither the queue lives in memory only.

import type { Changes } from "@/types/changes.gen";
import { newId } from "@/lib/ids";

/** A change as it is sent: its id, its name and its arguments, and the id of the change it takes back when it is an undo. */
export type OutboxChange = {
  [K in keyof Changes]: { id: string; type: K; args: Changes[K]; undoes?: string };
}[keyof Changes];

export interface OutboxItem {
  /** Sorts by the time the change was made: the order to send in. */
  key: string;
  slug: string;
  /** Who made it. A change is never sent under another account. */
  user: string;
  /** The tab that holds it now. */
  tab: string;
  /** One all-or-nothing batch, each change with the id it was given. */
  changes: OutboxChange[];
  /** What to call it in a note, should the server refuse it after a reload. */
  what: string;
  at: number;
}

const DB_NAME = "quadit-outbox";
const STORE = "changes";
/** Changes nobody came back for in this long are dropped. */
const KEEP_MS = 30 * 24 * 3600_000;

/** This page's name among the tabs. A reload makes a new one, which is how a reloaded tab's changes become free to take. */
const TAB = newId();
const tabLock = (tab: string) => `quadit-tab-${tab}`;
const hasLocks = typeof navigator !== "undefined" && "locks" in navigator;

// Held for as long as the page lives: other tabs see by it that this tab's changes are spoken for.
if (hasLocks) {
  try {
    void navigator.locks.request(tabLock(TAB), () => new Promise<void>(() => {})).catch(() => {});
  } catch {
    // No locks after all: every tab then takes over whatever it finds.
  }
}

/** What this tab has kept and not yet seen answered. Changed by put, remove, clear and takeOver, each of which then copies it. */
const held = new Map<string, OutboxItem>();

/** Where each tab's copy of what it holds is kept in localStorage: under its own name, so tabs do not write over each other. */
const COPY = "quadit.outbox.tab.";

function copyHeld() {
  try {
    if (held.size > 0) localStorage.setItem(COPY + TAB, JSON.stringify([...held.values()]));
    else localStorage.removeItem(COPY + TAB);
  } catch {
    // No storage: only what reached IndexedDB is kept.
  }
}

/** The copies in localStorage, each with its tab, leaving out this tab's own and those of `living` tabs. */
function copies(living: Set<string> | null): { name: string; items: OutboxItem[] }[] {
  const found: { name: string; items: OutboxItem[] }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      const tab = name?.startsWith(COPY) ? name.slice(COPY.length) : undefined;
      if (!name || !tab || tab === TAB || living?.has(tab)) continue;
      try {
        found.push({ name, items: JSON.parse(localStorage.getItem(name) ?? "[]") as OutboxItem[] });
      } catch {
        found.push({ name, items: [] });
      }
    }
  } catch {
    // No storage: no copies.
  }
  return found;
}

function forget(names: string[]) {
  try {
    for (const name of names) localStorage.removeItem(name);
  } catch {
    // No storage: nothing to forget.
  }
}

/** The items in IndexedDB, and those only in the copies of the tabs that are not `living`. */
async function everything(living: Set<string> | null) {
  const kept = await all();
  const keys = new Set(kept.map((item) => item.key));
  const found = copies(living);
  // A change that reached IndexedDB too is the same change: the one there counts.
  const onlyCopied = found.flatMap((copy) => copy.items).filter((item) => !keys.has(item.key));
  return { items: [...kept, ...onlyCopied], onlyCopied, names: found.map((copy) => copy.name) };
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => {
        // Another tab wants a newer layout: let go so it can have it.
        req.result.onversionchange = () => {
          req.result.close();
          opening = null;
        };
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** Runs one transaction; resolves with its result, or with `fallback` if the browser would not. */
async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void,
  fallback: T,
): Promise<T> {
  const db = await open();
  if (!db) return fallback;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : fallback);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

// One write at a time, in the order asked: a change is never removed before it was put.
let tail: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => {});
  return next;
}

const all = () => run<OutboxItem[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxItem[]>, []);

/** The ids of the tabs that are open now, or null when the browser cannot say. */
async function livingTabs(): Promise<Set<string> | null> {
  if (!hasLocks) return null;
  try {
    const { held = [] } = await navigator.locks.query();
    const prefix = tabLock("");
    return new Set(
      held
        .map((l) => l.name ?? "")
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length)),
    );
  } catch {
    return null;
  }
}

async function takeOver(slug: string, user: string): Promise<OutboxItem[]> {
  const living = await livingTabs();
  const { items, onlyCopied, names } = await everything(living);
  const now = Date.now();
  const mine: OutboxItem[] = [];
  const stale: string[] = [];
  for (const item of items) {
    if (now - item.at > KEEP_MS) stale.push(item.key);
    else if (item.slug === slug && item.user === user && item.tab !== TAB && !living?.has(item.tab))
      mine.push({ ...item, tab: TAB });
  }
  // What a tab that is gone left only in its copy, and is not taken now (another workspace, another person), moves to IndexedDB.
  const taken = new Set(mine.map((item) => item.key));
  const moved = onlyCopied.filter((item) => !taken.has(item.key) && !stale.includes(item.key));
  if (mine.length || stale.length || moved.length) {
    await run<undefined>(
      "readwrite",
      (s) => {
        for (const key of stale) s.delete(key);
        for (const item of [...mine, ...moved]) s.put(item);
      },
      undefined,
    );
  }
  forget(names);
  for (const item of mine) held.set(item.key, item);
  copyHeld();
  return mine.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Where the last person to queue a change on this device is remembered, for counting before anyone is known to be signed in. */
const LAST_USER = "quadit.outbox.user";

export const outbox = {
  /** A key for a new item: later ones sort after earlier ones. */
  newKey: () => newId(),

  put(item: Omit<OutboxItem, "tab">): void {
    try {
      localStorage.setItem(LAST_USER, item.user);
    } catch {
      // No storage: the count on the waiting screen is then left out.
    }
    held.set(item.key, { ...item, tab: TAB });
    copyHeld();
    void inOrder(() => run<undefined>("readwrite", (s) => void s.put({ ...item, tab: TAB }), undefined));
  },

  /** Who last queued a change on this device; undefined when unknown. */
  lastUser(): string | undefined {
    try {
      return localStorage.getItem(LAST_USER) ?? undefined;
    } catch {
      return undefined;
    }
  },

  remove(key: string): void {
    held.delete(key);
    copyHeld();
    void inOrder(() => run<undefined>("readwrite", (s) => void s.delete(key), undefined));
  },

  /**
   * The changes a page that is gone (reloaded, closed) left unsent for this
   * workspace and person, oldest first. They now belong to this tab. Only
   * one tab takes them: taking is done under a lock.
   */
  adopt(slug: string, user: string): Promise<OutboxItem[]> {
    return inOrder(async () => {
      if (!hasLocks) return takeOver(slug, user);
      try {
        return await navigator.locks.request("quadit-outbox", () => takeOver(slug, user));
      } catch {
        return takeOver(slug, user);
      }
    });
  },

  /** How many edits are kept for this workspace and person, whichever tab holds them. A batch counts once, as in the top bar. */
  async count(slug: string, user: string): Promise<number> {
    const { items } = await inOrder(() => everything(null));
    let n = 0;
    for (const item of items) if (item.slug === slug && item.user === user) n++;
    return n;
  },

  /** Forgets everything kept on this device, for every workspace. Done at sign-out. */
  clear(): Promise<void> {
    try {
      localStorage.removeItem(LAST_USER);
    } catch {
      // Nothing was remembered.
    }
    held.clear();
    forget(copies(null).map((copy) => copy.name));
    copyHeld();
    return inOrder(() => run<undefined>("readwrite", (s) => void s.clear(), undefined));
  },
};

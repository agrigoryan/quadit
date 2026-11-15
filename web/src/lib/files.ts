// Uploading files and telling what kind they are.
//
// A file goes up in parts of 8 MB. If the connection drops, the same part is
// sent again once the server can be reached, from wherever the server says
// it got to, so a long upload interrupted at 60% carries on from there.
// While there is no connection an upload simply waits; the change that
// attaches the file is made by the caller after uploadFile resolves, so it
// can never be sent ahead of its file. A waiting file is held in memory
// only: reloading the page drops it, so the browser asks before leaving.

import { create } from "zustand";
import { api, ApiError, NetworkError, ws } from "@/lib/api";
import { newId } from "@/lib/ids";
import { getState, useStore } from "@/lib/store";
import type { FileRow } from "@/lib/types";
import { localPath } from "@/lib/url";

/** Files larger than this go in parts of this size. */
export const PART_BYTES = 8 * 1024 * 1024;
/** Uploads sent at the same time; the rest wait their turn. */
const AT_ONCE = 3;
/** Times in a row the server may fail on one part (answering, but with an error of its own) before the upload gives up. */
const SERVER_TRIES = 6;

export interface UploadProgress {
  /** Bytes the server has, plus those of the part on its way. */
  sent: number;
  total: number;
  /** "queued": behind other uploads. "waiting": no connection; it carries on by itself. */
  state: "queued" | "sending" | "waiting";
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Gives the upload up. uploadFile then rejects with an AbortError. */
  signal?: AbortSignal;
}

/** One upload under way, for whoever shows them all (the top bar does). */
export interface Transfer extends UploadProgress {
  id: string;
  name: string;
}

/** Every upload under way on this page, oldest first. */
export const useTransfers = create<{ items: Transfer[] }>(() => ({ items: [] }));

// An upload is held in memory only, so leaving the page drops it: while one
// is queued, waiting or being sent, the browser asks before it lets go.
function warnBeforeLeaving(e: BeforeUnloadEvent) {
  e.preventDefault();
  // Older browsers ask only when this is set.
  e.returnValue = "";
}
if (typeof window !== "undefined") {
  useTransfers.subscribe((s) => {
    if (s.items.length > 0) window.addEventListener("beforeunload", warnBeforeLeaving);
    else window.removeEventListener("beforeunload", warnBeforeLeaving);
  });
}

/** A file as the server describes it while its parts arrive. */
interface ServerFile extends FileRow {
  received?: number;
}

let active = 0;
const turns: (() => void)[] = [];
const waiters = new Set<() => void>();

function wakeAll() {
  for (const wake of [...waiters]) wake();
}
if (typeof window !== "undefined") window.addEventListener("online", wakeAll);
// The live stream coming back is the surest sign the server can be reached again.
useStore.subscribe((s, prev) => {
  if (s.stream === "live" && prev.stream !== "live") wakeAll();
});

/** Waits before a retry; the connection coming back, or giving up, ends the wait early. */
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
    signal?.addEventListener("abort", done);
  });
}

const aborted = () => new DOMException("aborted", "AbortError");
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function sendInParts(
  slug: string,
  file: File,
  report: (sent: number, state: UploadProgress["state"]) => void,
  signal?: AbortSignal,
): Promise<ServerFile> {
  const base = ws(slug, "/files");
  let row: ServerFile | null = null;
  let netTries = 0;
  let serverTries = 0;
  for (;;) {
    if (signal?.aborted) throw aborted();
    const from: number = row?.received ?? 0;
    try {
      if (offline()) throw new NetworkError();
      const part = file.slice(from, from + PART_BYTES);
      const opts = {
        contentType: file.type,
        signal,
        onProgress: (n: number) => report(Math.min(file.size, from + n), "sending"),
      };
      report(from, "sending");
      row = row
        ? await api.send<ServerFile>("PATCH", `${base}/${row.id}?offset=${from}`, part, opts)
        : await api.send<ServerFile>(
            "POST",
            `${base}?name=${encodeURIComponent(file.name)}&size=${file.size}`,
            part,
            opts,
          );
      netTries = 0;
      serverTries = 0;
      if (row.state !== "uploading") return row;
    } catch (err) {
      if (isAbort(err)) throw err;
      const lost = err instanceof NetworkError;
      const serverFault = err instanceof ApiError && err.status >= 500;
      const moved = err instanceof ApiError && err.status === 409 && row;
      if (!lost && !serverFault && !moved) throw err;
      if ((serverFault || moved) && ++serverTries >= SERVER_TRIES) throw err;
      if (lost || serverFault) {
        if (lost) netTries++;
        report(from, lost ? "waiting" : "sending");
        await pause(Math.min(1000 * 2 ** Math.min(lost ? netTries : serverTries, 4), 15_000), signal);
        if (signal?.aborted) throw aborted();
      }
      // Ask how much arrived: the part may have landed although its answer did not.
      if (row) row = await whereItStands(base, row, signal);
      // The last part had landed; only its answer was lost.
      if (row && row.state !== "uploading") return row;
    }
  }
}

/** The file as the server has it now; the row as last known if the server cannot be asked; null if it is no longer there. */
async function whereItStands(base: string, row: ServerFile, signal?: AbortSignal): Promise<ServerFile | null> {
  try {
    return await api.get<ServerFile>(`${base}/${row.id}`, signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    // Gone on the server (cleaned up after a long wait): start the file again.
    if (err instanceof ApiError && err.status === 404) return null;
    if (err instanceof ApiError && err.status < 500) throw err;
    return row;
  }
}

/**
 * Sends one file to the workspace. Attach the returned file with
 * `attachment.add` or inside a comment or option. Resolves once the whole
 * file is on the server, however long the connection was away meanwhile.
 */
export async function uploadFile(file: File, opts: UploadOptions = {}): Promise<FileRow> {
  const slug = getState().slug;
  const id = newId();
  const set = (sent: number, state: UploadProgress["state"]) => {
    const cur = useTransfers.getState().items.find((it) => it.id === id);
    if (!cur || (cur.sent === sent && cur.state === state)) return;
    useTransfers.setState((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, sent, state } : it)) }));
    opts.onProgress?.({ sent, total: file.size, state });
  };
  useTransfers.setState((s) => ({
    items: [...s.items, { id, name: file.name, sent: 0, total: file.size, state: "queued" }],
  }));
  opts.onProgress?.({ sent: 0, total: file.size, state: "queued" });
  try {
    if (active >= AT_ONCE) {
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          opts.signal?.removeEventListener("abort", quit);
          resolve();
        };
        const quit = () => {
          turns.splice(turns.indexOf(turn), 1);
          reject(aborted());
        };
        turns.push(turn);
        opts.signal?.addEventListener("abort", quit);
      });
    } else {
      active++;
    }
    try {
      const row = await sendInParts(slug, file, set, opts.signal);
      return { ...row, url: localPath(row.url) as string, preview_url: localPath(row.preview_url) };
    } finally {
      // Hand the place to the next in line, or give it back.
      const next = turns.shift();
      if (next) next();
      else active--;
    }
  } finally {
    useTransfers.setState((s) => ({ items: s.items.filter((it) => it.id !== id) }));
  }
}

export const isImage = (f: Pick<FileRow, "content_type"> | undefined) => !!f?.content_type.startsWith("image/");
export const isVideo = (f: Pick<FileRow, "content_type"> | undefined) => !!f?.content_type.startsWith("video/");
export const isMedia = (f: Pick<FileRow, "content_type"> | undefined) => isImage(f) || isVideo(f);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

/** Copies text, answering whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Uploads under way live in this module; reload instead of hot-swapping it in development.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

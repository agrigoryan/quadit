// What a task carries only once it is opened: its description, comments,
// links, files and watchers (merged into the store), and its history (the
// raw events, kept here for the timeline).

import { useEffect } from "react";
import { create } from "zustand";
import { api, ApiError, ws } from "@/lib/api";
import { getState, markOpened, mergeRows, onEvents, onReplaced, removeRow, useStore } from "@/lib/store";
import type { AgentSession, Attachment, Comment, FeedEvent, Task, TaskLink, Watcher } from "@/lib/types";

interface RawTask {
  task: Task;
  comments: Comment[];
  links: TaskLink[];
  watchers: Watcher[];
  attachments: Attachment[];
  sessions: AgentSession[];
}

interface DetailState {
  /** A task's events, oldest first, by task id. */
  events: Record<string, FeedEvent[]>;
  /** "loading", "ready", or the reason the load failed, by task id. */
  status: Record<string, string>;
}

const useTaskDetailStore = create<DetailState>(() => ({ events: {}, status: {} }));

// A history belongs to the copy it was fetched for: at sign-out, in another
// workspace, or once the person's access changed, none of it may remain.
onReplaced(() => useTaskDetailStore.setState({ events: {}, status: {} }));

function setStatus(taskId: string, status: string) {
  useTaskDetailStore.setState((s) => ({ status: { ...s.status, [taskId]: status } }));
}

/** Fetches everything in a task and merges it into the store. */
async function loadTask(taskId: string): Promise<void> {
  const { slug } = getState();
  if (!useTaskDetailStore.getState().events[taskId]) setStatus(taskId, "loading");
  try {
    const [raw, feed] = await Promise.all([
      api.get<RawTask>(ws(slug, `/tasks/${taskId}?raw=1`)),
      api.get<{ events: FeedEvent[] }>(ws(slug, `/events?task=${taskId}&limit=500`)),
    ]);
    // The copy was replaced while this was on its way: the answer is for the old one.
    if (getState().slug !== slug) return;
    // Rows that were deleted while nobody was looking are not in the answer.
    const { comments, attachments, links } = getState().c;
    const fresh = new Set([...raw.comments, ...raw.attachments, ...raw.links].map((r) => r.id));
    for (const [name, table] of [
      ["comments", comments],
      ["attachments", attachments],
      ["links", links],
    ] as const) {
      for (const row of Object.values(table)) {
        if (row.task_id === taskId && !fresh.has(row.id)) removeRow(name, row.id);
      }
    }
    mergeRows("tasks", [raw.task]);
    mergeRows("comments", raw.comments);
    mergeRows("links", raw.links);
    mergeRows("watchers", raw.watchers);
    mergeRows("attachments", raw.attachments);
    mergeRows("sessions", raw.sessions);
    markOpened(taskId);
    useTaskDetailStore.setState((s) => ({
      events: { ...s.events, [taskId]: mergeEvents(s.events[taskId] ?? [], feed.events) },
      status: { ...s.status, [taskId]: "ready" },
    }));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    setStatus(taskId, err instanceof Error ? err.message : "failed");
  }
}

function mergeEvents(have: FeedEvent[], more: FeedEvent[]): FeedEvent[] {
  const bySeq = new Map<number, FeedEvent>();
  for (const ev of have) bySeq.set(ev.seq, ev);
  for (const ev of more) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Live events join the history of any task that has been opened.
onEvents((events) => {
  const open = useTaskDetailStore.getState().events;
  const touched: Record<string, FeedEvent[]> = {};
  for (const ev of events) {
    if (ev.scope_type !== "task" || !open[ev.scope_id]) continue;
    (touched[ev.scope_id] ??= []).push(ev);
  }
  const ids = Object.keys(touched);
  if (ids.length === 0) return;
  useTaskDetailStore.setState((s) => {
    const next = { ...s.events };
    for (const id of ids) next[id] = mergeEvents(next[id] ?? [], touched[id] ?? []);
    return { events: next };
  });
});

const NO_EVENTS: FeedEvent[] = [];

/**
 * Loads a task's contents when it opens, and again whenever the live stream
 * comes back (anything missed while it was down is then fetched).
 * Returns "loading", "ready" or an error message.
 */
export function useTaskDetail(taskId: string | undefined): string {
  const live = useStore((s) => s.stream === "live");
  useEffect(() => {
    if (taskId && live) void loadTask(taskId);
  }, [taskId, live]);
  // Not fetched yet, or thrown away with the copy it was fetched for (the person's access changed).
  const missing = useTaskDetailStore((s) => !!taskId && !s.status[taskId]);
  useEffect(() => {
    if (taskId && missing) void loadTask(taskId);
  }, [taskId, missing]);
  return useTaskDetailStore((s) => (taskId ? (s.status[taskId] ?? "loading") : "loading"));
}

/** A task's history, oldest first. Empty until useTaskDetail has loaded it. */
export function useTaskEvents(taskId: string | undefined): FeedEvent[] {
  return useTaskDetailStore((s) => (taskId ? (s.events[taskId] ?? NO_EVENTS) : NO_EVENTS));
}

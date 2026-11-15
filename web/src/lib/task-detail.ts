// What a task carries only once it is opened: its description, comments,
// links, files and watchers (merged into the store, which owns them), and
// its history (the raw events, which only the timeline reads: they are the
// query's own data, and live events are added to it as they come).

import { useQuery } from "@tanstack/react-query";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace, queryClient, readError } from "@/lib/query";
import { getState, markOpened, mergeRows, onEvents, removeRow, useStore } from "@/lib/store";
import type { AgentSession, Attachment, Comment, FeedEvent, Task, TaskLink, Watcher } from "@/lib/types";

interface RawTask {
  task: Task;
  comments: Comment[];
  links: TaskLink[];
  watchers: Watcher[];
  attachments: Attachment[];
  sessions: AgentSession[];
}

export const taskKeys = {
  /** A task opened whole: its rows go to the store, its history is the data. */
  detail: (slug: string, taskId: string) => [...inWorkspace(slug), "task", taskId] as const,
  /** A task the store does not have, looked up by key or id to put it there. */
  row: (slug: string, keyOrId: string) => [...inWorkspace(slug), "task-row", keyOrId] as const,
};

/** Fetches everything in a task, merges it into the store and answers its history, oldest first. */
async function fetchTask(slug: string, taskId: string, signal: AbortSignal): Promise<FeedEvent[]> {
  const [raw, feed] = await Promise.all([
    api.get<RawTask>(workspacePath(slug, `/tasks/${taskId}?raw=1`), signal),
    api.get<{ events: FeedEvent[] }>(workspacePath(slug, `/events?task=${taskId}&limit=500`), signal),
  ]);
  const had = queryClient.getQueryData<FeedEvent[]>(taskKeys.detail(slug, taskId)) ?? [];
  // The copy was replaced while this was on its way: the rows are for the old one.
  if (getState().slug !== slug) return mergeEvents(had, feed.events);
  // Rows that were deleted while nobody was looking are not in the answer.
  const { comments, attachments, links } = getState().collections;
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
  return mergeEvents(had, feed.events);
}

function mergeEvents(have: FeedEvent[], more: FeedEvent[]): FeedEvent[] {
  const bySeq = new Map<number, FeedEvent>();
  for (const ev of have) bySeq.set(ev.seq, ev);
  for (const ev of more) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Live events join the history of any task that has been opened.
onEvents((events) => {
  const slug = getState().slug;
  const touched: Record<string, FeedEvent[]> = {};
  for (const ev of events) if (ev.scope_type === "task") (touched[ev.scope_id] ??= []).push(ev);
  for (const [id, more] of Object.entries(touched)) {
    queryClient.setQueryData<FeedEvent[]>(taskKeys.detail(slug, id), (have) => have && mergeEvents(have, more));
  }
});

const NO_EVENTS: FeedEvent[] = [];

/** `fetch` false only reads what useTaskDetail fetched, so that a second reader of the task asks nothing. */
const useTaskQuery = (taskId: string | undefined, fetch: boolean) => {
  const slug = useStore((s) => s.slug);
  return useQuery({
    queryKey: taskKeys.detail(slug, taskId ?? ""),
    queryFn: ({ signal }) => fetchTask(slug, taskId ?? "", signal),
    enabled: fetch && !!taskId,
  });
};

/**
 * Loads a task's contents when it opens (and again whenever the live stream
 * comes back: anything missed while it was down is then fetched). Returns
 * "loading", "ready" or an error message.
 */
export function useTaskDetail(taskId: string | undefined): string {
  const query = useTaskQuery(taskId, true);
  if (query.data) return "ready";
  // A 401 has sent the person to sign in: keep showing that it loads.
  return readError(query.error) || "loading";
}

/** A task's history, oldest first. Empty until useTaskDetail has loaded it. */
export function useTaskEvents(taskId: string | undefined): FeedEvent[] {
  return useTaskQuery(taskId, false).data ?? NO_EVENTS;
}

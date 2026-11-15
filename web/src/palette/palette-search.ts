// Finding things for the command palette. Commands match by the start of
// their words and tasks by plain substring, so results are predictable; the
// server's full-text search finds words inside comments and questions.

import { useEffect, useState } from "react";
import { api, workspacePath } from "@/lib/api";
import { isLive, useSlug } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import type { SearchHit, Task } from "@/types/core";

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * True when every word of the query starts a word of the text ("ke sh"
 * finds "Keyboard shortcuts"; "board" does not). An empty query matches all.
 */
export function matches(query: string, text: string): boolean {
  const have = words(text);
  return words(query).every((q) => have.some((word) => word.startsWith(q)));
}

/** Lower is better; -1 is no match. An exact key comes before everything. */
function score(task: Task, q: string): number {
  const key = task.key.toLowerCase();
  const title = task.title.toLowerCase();
  if (key === q) return 0;
  if (key.startsWith(q)) return 1;
  if (title.startsWith(q)) return 2;
  if (key.includes(q)) return 3;
  if (title.includes(q)) return 4;
  return q.split(/\s+/).every((word) => key.includes(word) || title.includes(word)) ? 5 : -1;
}

/** Tasks whose key or title holds the query, best first; one in the trash or the archive is never found. */
export function searchTasks(tasks: Task[], query: string, limit = 8): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const found: { task: Task; score: number }[] = [];
  for (const task of tasks) {
    if (!isLive(task)) continue;
    const s = score(task, q);
    if (s >= 0) found.push({ task, score: s });
  }
  found.sort((a, b) => a.score - b.score || b.task.updated_at - a.task.updated_at);
  return found.slice(0, limit).map((f) => f.task);
}

/**
 * The server's hits less those in a task the store has as gone: the server
 * finds words in archived tasks too, and its answer may predate a task's
 * going. `tasks` holds every task by id, gone ones included. A hit in a task
 * the store does not have yet (a finished one still on its way) stays.
 */
export function hitsOnLiveTasks(hits: SearchHit[], tasks: Dict<Task>): SearchHit[] {
  return hits.filter((hit) => {
    const known = hit.scope_type === "task" ? tasks[hit.scope_id] : undefined;
    return !known || isLive(known);
  });
}

/**
 * Asks the server to search every text for the query, a moment after the
 * typing stops. A newer query cancels the request of an older one.
 */
export function useServerSearch(query: string): { hits: SearchHit[]; busy: boolean } {
  const slug = useSlug();
  const q = query.trim();
  const [answer, setAnswer] = useState<{ q: string; hits: SearchHit[] }>({ q: "", hits: [] });

  useEffect(() => {
    if (q.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api
        .get<{ hits: SearchHit[] }>(workspacePath(slug, `/search?q=${encodeURIComponent(q)}`), ctl.signal)
        .then((out) => setAnswer({ q, hits: out.hits ?? [] }))
        .catch(() => {
          // A failed search just finds nothing; a cancelled one is replaced by the next.
          if (!ctl.signal.aborted) setAnswer({ q, hits: [] });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, slug]);

  if (q.length < 2) return { hits: [], busy: false };
  return { hits: answer.q === q ? answer.hits : [], busy: answer.q !== q };
}

/**
 * The server marks the words it matched as **word**. Returns the text in
 * pieces so it can be drawn without ever treating it as markup.
 */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  return snippet
    .split(/\*\*(.+?)\*\*/g)
    .map((text, i) => ({ text, hit: i % 2 === 1 }))
    .filter((part) => part.text !== "");
}

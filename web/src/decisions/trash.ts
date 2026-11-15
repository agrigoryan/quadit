// The trash for questions. The workspace's starting copy leaves deleted
// decisions out, so the server is asked for them. A question deleted or restored
// while the app is open is in the copy and shows up or drops out at once,
// and the list is asked for again.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace, queryClient, readError } from "@/lib/query";
import { useLookupEvenIfGone, useSlug } from "@/lib/selectors";
import { onEvents } from "@/lib/store";

interface TrashedDecision {
  id: string;
  question: string;
  /** The key of the task it was asked on: "SVA-1". */
  taskKey: string;
  taskId?: string;
  deletedAt?: number;
}

/** A deleted decision as the server lists it. */
interface Listed {
  id: string;
  question: string;
  task?: string;
  task_id?: string;
  deleted_at?: number;
}

interface Fetched {
  listed: Listed[];
}

const trashKey = (slug: string) => [...inWorkspace(slug), "decisions-trash"] as const;

async function fetchTrash(slug: string, signal: AbortSignal): Promise<Fetched> {
  const list = await api.get<{ decisions?: Listed[] }>(workspacePath(slug, "/decisions?trash=1&limit=500"), signal);
  return { listed: list.decisions ?? [] };
}

export interface DecisionTrash {
  rows: TrashedDecision[];
  /** True until the first answer. */
  loading: boolean;
  error: string;
}

/** Deleted questions, newest deletion first. */
export function useTrashedDecisions(): DecisionTrash {
  const slug = useSlug();
  // The trash: the deleted questions themselves, and the tasks they were on, which may be gone too.
  const decisions = useLookupEvenIfGone("decisions");
  const tasks = useLookupEvenIfGone("tasks");
  // Asked again when the stream comes back (deletions made meanwhile were missed) and when a question is deleted or restored.
  const query = useQuery({ queryKey: trashKey(slug), queryFn: ({ signal }) => fetchTrash(slug, signal) });
  const fetched = query.data;
  useEffect(
    () =>
      onEvents((events) => {
        if (events.some((ev) => ev.type === "decision.deleted" || ev.type === "decision.restored"))
          void queryClient.invalidateQueries({ queryKey: trashKey(slug) });
      }),
    [slug],
  );
  const error = readError(query.error);

  const rows = useMemo(() => {
    const out: TrashedDecision[] = [];
    const seen = new Set<string>();
    for (const d of fetched?.listed ?? []) {
      seen.add(d.id);
      const here = decisions[d.id];
      // In the copy and not deleted: it was restored a moment ago.
      if (here && !here.deleted_at) continue;
      out.push({
        id: d.id,
        question: d.question,
        taskKey: d.task ?? "",
        taskId: here?.task_id ?? d.task_id,
        deletedAt: here?.deleted_at ?? d.deleted_at,
      });
    }
    // Deleted a moment ago: in the copy before the list has been asked for again.
    for (const d of Object.values(decisions)) {
      if (!d.deleted_at || seen.has(d.id)) continue;
      out.push({
        id: d.id,
        question: d.question,
        taskKey: tasks[d.task_id]?.key ?? "",
        taskId: d.task_id,
        deletedAt: d.deleted_at,
      });
    }
    return out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }, [fetched, decisions, tasks]);

  // A 401 is no answer: the person is on the way to sign in.
  return { rows, loading: query.isPending || (!!query.error && !error), error };
}

// The trash for questions. The workspace's starting copy leaves deleted
// decisions out, so the server is asked for them. A question deleted or restored
// while the app is open is in the copy and shows up or drops out at once,
// and the list is asked for again.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, errorMessage, ws } from "@/lib/api";
import { useCollection, useSlug } from "@/lib/selectors";
import { onEvents, useStore } from "@/lib/store";

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

async function fetchTrash(slug: string, signal: AbortSignal): Promise<Fetched> {
  const list = await api.get<{ decisions?: Listed[] }>(ws(slug, "/decisions?trash=1&limit=500"), signal);
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
  const decisions = useCollection("decisions");
  const tasks = useCollection("tasks");
  // Asked again when the stream comes back: deletions made meanwhile were missed.
  const live = useStore((s) => s.stream === "live");
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [error, setError] = useState("");
  const run = useRef(0);

  useEffect(() => {
    const ctl = new AbortController();
    const load = () => {
      const mine = ++run.current;
      fetchTrash(slug, ctl.signal).then(
        (out) => {
          if (mine !== run.current) return;
          setFetched(out);
          setError("");
        },
        (err: unknown) => {
          if (mine !== run.current || ctl.signal.aborted) return;
          if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
        },
      );
    };
    load();
    const off = onEvents((events) => {
      if (events.some((ev) => ev.type === "decision.deleted" || ev.type === "decision.restored")) load();
    });
    return () => {
      off();
      ctl.abort();
      run.current++;
    };
  }, [slug, live]);

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

  return { rows, loading: fetched === null && !error, error };
}

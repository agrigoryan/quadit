// What the agents page works out from the store for each agent: the task it
// holds, what waits on it, and its place in the queues of shared resources.

import { useMemo } from "react";
import { useCollection } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import { type Decision, isOpenCategory, type Task } from "@/lib/types";
import type { Claim, Resource } from "@/insights/lib/types";

interface Asked {
  decision: Decision;
  task: Task;
}

export interface AgentWork {
  /** Tasks it has taken (a lease), whether or not the lease still runs. */
  held: Task[];
  /** Open tasks handed to it, other than those that carry a question asked of it. */
  waiting: Task[];
  /** Open questions asked of it. */
  asked: Asked[];
  /** Its live claims on shared resources. */
  claims: Claim[];
}

const empty = (): AgentWork => ({ held: [], waiting: [], asked: [], claims: [] });

/** Live claims in queue order: the holder first, then by when each asked. */
export function useClaims(): Claim[] {
  const claims = useCollection("claims");
  return useMemo(
    () =>
      (Object.values(claims) as unknown as Claim[])
        .filter((c) => c.state !== "released")
        .sort(
          (a, b) =>
            Number(b.state === "holding") - Number(a.state === "holding") ||
            a.requested_at - b.requested_at ||
            (a.id < b.id ? -1 : 1),
        ),
    [claims],
  );
}

export function useResources(): Resource[] {
  const resources = useCollection("resources");
  return useMemo(
    () =>
      (Object.values(resources) as unknown as Resource[])
        .filter((r) => !r.deleted_at)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [resources],
  );
}

/** Every agent's work, by user id. */
export function useAgentWork(claims: Claim[]): Dict<AgentWork> {
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const decisions = useCollection("decisions");
  return useMemo(() => {
    const out: Dict<AgentWork> = {};
    const of = (id: string) => (out[id] ??= empty());
    for (const task of Object.values(tasks)) {
      if (task.deleted_at || task.archived_at || !isOpenCategory(statuses[task.status_id]?.category)) continue;
      if (task.lease_holder_id && task.lease_until) of(task.lease_holder_id).held.push(task);
      if (task.waiting_on_id) of(task.waiting_on_id).waiting.push(task);
    }
    for (const decision of Object.values(decisions)) {
      if (decision.state !== "open" || decision.deleted_at || !decision.asked_id) continue;
      const task = tasks[decision.task_id];
      if (task && !task.deleted_at) of(decision.asked_id).asked.push({ decision, task });
    }
    for (const claim of claims) of(claim.user_id).claims.push(claim);
    for (const work of Object.values(out)) {
      // A question makes its task wait on whoever was asked: show the question, not both.
      const questioned = new Set(work.asked.map((a) => a.task.id));
      work.waiting = work.waiting.filter((task) => !questioned.has(task.id));
      work.waiting.sort((a, b) => a.updated_at - b.updated_at);
      work.asked.sort((a, b) => a.decision.created_at - b.decision.created_at);
    }
    return out;
  }, [tasks, statuses, decisions, claims]);
}

export const NO_WORK: AgentWork = empty();

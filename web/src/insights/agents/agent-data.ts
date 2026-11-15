// What the agents page works out from the store for each agent: the task it
// holds, what waits on it, and its place in the queues of shared resources.

import { useMemo } from "react";
import { useLiveTasks, useLookup, useOpenDecisions, useRows } from "@/data/selectors";
import type { Dict } from "@/data/store";
import { type Decision, isOpenCategory, type Task } from "@/types/core";
import type { Claim, Resource } from "@/types/agents";

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
  const claims = useRows("claims");
  return useMemo(
    () =>
      claims
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
  const resources = useRows("resources");
  return useMemo(() => [...resources].sort((a, b) => a.name.localeCompare(b.name)), [resources]);
}

/** Every agent's work, by user id. */
export function useAgentWork(claims: Claim[]): Dict<AgentWork> {
  const tasks = useLiveTasks();
  const liveTasks = useLookup("tasks");
  const statuses = useLookup("statuses");
  const openDecisions = useOpenDecisions();
  return useMemo(() => {
    const out: Dict<AgentWork> = {};
    const of = (id: string) => (out[id] ??= empty());
    for (const task of tasks) {
      if (!isOpenCategory(statuses[task.status_id]?.category)) continue;
      if (task.lease_holder_id && task.lease_until) of(task.lease_holder_id).held.push(task);
      if (task.waiting_on_id) of(task.waiting_on_id).waiting.push(task);
    }
    for (const [taskId, open] of Object.entries(openDecisions)) {
      // Only on a live task: one in the trash or the archive waits on no one.
      const task = liveTasks[taskId];
      if (!task) continue;
      for (const decision of open) if (decision.asked_id) of(decision.asked_id).asked.push({ decision, task });
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
  }, [tasks, liveTasks, statuses, openDecisions, claims]);
}

export const NO_WORK: AgentWork = empty();

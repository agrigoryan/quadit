// Helpers: agents made for one task. A helper's member row names its maker
// (`delegated_by`) and the task (`delegated_task`), and the server suspends
// it when that task closes. Lists show a helper under its maker.

import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import type { Member } from "@/lib/types";
import type { AgentMember } from "@/settings/agents/data";

export const isHelper = (m: Member): boolean => !!(m as AgentMember).delegated_task;

/** A helper whose task has closed: the server suspended it and ended its tokens. */
export const isFinishedHelper = (m: Member): boolean => isHelper(m) && !!m.suspended_at;

export interface Placed<M extends Member = AgentMember> {
  agent: M;
  /** 0 for an agent of its own; 1 for a helper shown under its maker, 2 for a helper's helper. */
  depth: number;
}

/**
 * Agents in the order given, each followed by the helpers it made. A helper
 * whose maker is not in the list (a person made it, or the maker was
 * removed) keeps its own place. Finished helpers are left out unless asked
 * for; `hidden` counts them.
 */
export function placeHelpers<M extends Member>(
  agents: M[],
  showFinished: boolean,
): { rows: Placed<M>[]; hidden: number } {
  const ids = new Set(agents.map((a) => a.user_id));
  const maker = (a: M) => {
    const by = (a as AgentMember).delegated_by;
    return isHelper(a) && by && by !== a.user_id && ids.has(by) ? by : "";
  };
  const under = new Map<string, M[]>();
  for (const a of agents) {
    const by = maker(a);
    if (by) under.set(by, [...(under.get(by) ?? []), a]);
  }
  const rows: Placed<M>[] = [];
  let hidden = 0;
  const seen = new Set<string>();
  const add = (a: M, depth: number) => {
    if (seen.has(a.user_id)) return;
    seen.add(a.user_id);
    if (isFinishedHelper(a) && !showFinished) hidden++;
    else rows.push({ agent: a, depth });
    for (const child of under.get(a.user_id) ?? []) add(child, Math.min(depth + 1, 2));
  };
  for (const a of agents) if (!maker(a)) add(a, 0);
  // Two helpers that name each other have no top: show them anyway.
  for (const a of agents) add(a, 0);
  return { rows, hidden };
}

/** "Helper for SVA-12", for a helper's row; "" for any other member. */
export function useHelperLabel(): (m: Member) => string {
  const tasks = useCollection("tasks");
  return (m) => {
    const id = (m as AgentMember).delegated_task;
    if (!id) return "";
    const key = tasks[id]?.key;
    return key ? t("agents.helperFor", { task: key }) : t("agents.helperForTask");
  };
}

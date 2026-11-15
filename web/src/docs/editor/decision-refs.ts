// A decision is named in a page's text the way the server reads it: its
// task's key, "#", and its number on that task, counted from 1 in the order
// the questions were asked ("SVA-7#2"). These find one from the other in the
// workspace copy.

import { findTaskByKey } from "@/lib/selectors";
import type { Collections } from "@/lib/store";
import type { Decision, Task } from "@/lib/types";

export const DECISION_REF = /^([A-Z][A-Z0-9]{1,9}-\d{1,6})#(\d{1,3})$/;

const asked = (a: Decision, b: Decision) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A task's decisions in the order asked: the first is number 1. Those in the trash do not count. */
export function decisionsOf(c: Collections, taskId: string): Decision[] {
  return Object.values(c.decisions)
    .filter((d) => d.task_id === taskId && !d.deleted_at)
    .sort(asked);
}

export interface Found {
  task: Task;
  decision: Decision;
  /** "SVA-7#2" */
  ref: string;
}

/** The decision a reference names, if the task and that number exist. */
export function findDecision(c: Collections, ref: string): Found | undefined {
  const m = DECISION_REF.exec(ref.trim().toUpperCase());
  if (!m) return undefined;
  const task = findTaskByKey(c.tasks, m[1] as string);
  if (!task || task.deleted_at) return undefined;
  const decision = decisionsOf(c, task.id)[Number(m[2]) - 1];
  return decision ? { task, decision, ref: `${task.key}#${m[2]}` } : undefined;
}

/** How a decision is written in a page: its task's key and its number there. */
export function refOf(c: Collections, decision: Decision): string | undefined {
  const task = c.tasks[decision.task_id];
  if (!task || task.deleted_at) return undefined;
  const n = decisionsOf(c, task.id).findIndex((d) => d.id === decision.id);
  return n < 0 ? undefined : `${task.key}#${n + 1}`;
}

/** Every decision that can be mentioned, the open ones first, then the latest asked. */
export function mentionable(c: Collections): Found[] {
  const byTask = new Map<string, Decision[]>();
  for (const d of Object.values(c.decisions)) {
    if (d.deleted_at) continue;
    const list = byTask.get(d.task_id) ?? [];
    list.push(d);
    byTask.set(d.task_id, list);
  }
  const out: Found[] = [];
  for (const [taskId, list] of byTask) {
    const task = c.tasks[taskId];
    if (!task || task.deleted_at) continue;
    list.sort(asked).forEach((decision, i) => out.push({ task, decision, ref: `${task.key}#${i + 1}` }));
  }
  return out.sort(
    (a, b) =>
      Number(a.decision.state !== "open") - Number(b.decision.state !== "open") ||
      b.decision.created_at - a.decision.created_at,
  );
}

/** What was decided, in a word or two: the picked option's label, "Approved", "Declined"; nothing while it is open. */
export function answerOf(decision: Decision): {
  kind: "open" | "picked" | "approved" | "declined" | "sent_back";
  label?: string;
} {
  if (decision.state === "open") return { kind: "open" };
  if (decision.state === "sent_back" || decision.outcome === "none") return { kind: "sent_back" };
  if (decision.outcome === "approved") return { kind: "approved" };
  if (decision.outcome === "declined") return { kind: "declined" };
  const label = decision.options?.find((o) => o.id === decision.picked_option_id)?.label;
  return { kind: "picked", label };
}

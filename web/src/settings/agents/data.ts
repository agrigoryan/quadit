// What the Agents pages read beyond the store: what each agent is doing
// right now and the tokens issued to it.

import { useMemo } from "react";
import { useLive, useNow } from "@/lib/live";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import type { Member } from "@/lib/types";

interface Scope {
  projects?: string[];
  read_only?: boolean;
  needs_approval?: string[];
}

interface Budget {
  cost_micros?: number;
  minutes?: number;
  /** How many times a week it may pass work on to another agent. */
  handoffs?: number;
}

/** A member row with the fields only agents use. */
export interface AgentMember extends Member {
  scope?: Scope;
  budget?: Budget;
  last_action?: string;
  /** A helper made for one task: the user id of its maker, and the task. It is suspended when the task closes. */
  delegated_by?: string;
  delegated_task?: string;
}

/** A person's limits in this workspace: the same shape, without the approvals only agents have. */
export type ScopedMember = Member & { scope?: Scope };

export interface AgentState {
  handle: string;
  user_id: string;
  state: "working" | "waiting" | "has_work" | "idle";
  task?: string;
  doing?: string;
  waits_on?: string;
  listening: boolean;
  open_tasks: number;
  waiting_on_it: number;
  cost_week?: string;
  minutes_week?: number;
}

export interface Token {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  /** Space-separated: "read", "project:<id>". */
  scopes?: string;
  kind: string;
  created_by: string;
  created_at: number;
  expires_at?: number;
  last_used_at?: number;
}

/**
 * What every agent is doing right now, by user id. It is the same reading
 * the Agents page shows (GET /agents, kept current as the feed moves), so
 * "Listening" means the same thing in both places.
 */
export function useAgentStates(): { data: Record<string, AgentState> | undefined; error: string } {
  const live = useLive<{ agents: AgentState[] }>("/agents", {
    only: ["member", "task", "session", "webhook", "decision"],
  });
  const data = useMemo(() => {
    if (!live.data) return undefined;
    const out: Record<string, AgentState> = {};
    for (const a of live.data.agents) out[a.user_id] = a;
    return out;
  }, [live.data]);
  return { data, error: live.error };
}

/**
 * Whether something is listening for a member's work, for lists where
 * people choose one. The server's reading when it is here; until then what
 * the member row says (a held request). Undefined for people.
 */
export function useListening(): (member: Member | undefined) => boolean | undefined {
  const states = useAgentStates();
  const members = useCollection("members");
  const now = useNow();
  return (member) => {
    if (!member || member.kind !== "agent") return undefined;
    const state = states.data?.[member.user_id];
    if (state) return state.listening;
    return (members[member.user_id]?.listening_until ?? 0) > now;
  };
}

/** A member in a plain select: "Coder (@coder) · nothing is listening". */
export function memberChoiceLabel(member: Member, listening: boolean | undefined): string {
  const base = `${member.name} (@${member.handle})`;
  if (listening === undefined) return base;
  return `${base} · ${listening ? t("agents.choice.listening") : t("agents.choice.notListening")}`;
}

export const dollars = (micros: number | undefined) => (micros ? String(micros / 1_000_000) : "");

/** "12.50" → 12500000; "" → 0 (no limit); anything else → null. */
export function toMicros(text: string): number | null {
  const s = text.trim().replace(/^\$/, "");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
}

/** A whole number of minutes or hand-offs; "" → 0 (no limit); anything else → null. */
export function toMinutes(text: string): number | null {
  const s = text.trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

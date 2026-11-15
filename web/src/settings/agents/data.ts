// The shapes the Agents pages work with beyond the store (an agent's limits,
// the tokens issued to it) and how their fields are written. What each agent
// is doing right now is in lib/listening.ts.

import { t } from "@/lib/i18n";
import type { Member } from "@/types/core";

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

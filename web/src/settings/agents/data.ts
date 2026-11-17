// The shapes the Agents pages work with beyond the store (an agent's limits,
// the tokens issued to it) and how their fields are written. What each agent
// is doing right now is in data/listening.ts.

import { t } from "@/lib/i18n";
import type { Member } from "@/types/core";

interface Scope {
  projects?: string[];
  read_only?: boolean;
  needs_approval?: string[];
}

/** A member row with the fields only agents use. */
export interface AgentMember extends Member {
  scope?: Scope;
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

/** A limit typed in a box: a whole number, zero or more; "" → 0 (no limit); anything else → null. */
export function toLimit(text: string): number | null {
  const s = text.trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

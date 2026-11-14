// What the Agents pages read beyond the store: what each agent is doing
// right now, who answers for it, and the tokens issued to it.

import { useSession } from "@/auth/session";
import { api, ws } from "@/lib/api";
import { useSlug } from "@/lib/selectors";
import type { Member } from "@/lib/types";
import { useLoad } from "@/settings/ui/use-load";

export interface Scope {
  projects?: string[];
  read_only?: boolean;
  needs_approval?: string[];
}

export interface Budget {
  cost_micros?: number;
  minutes?: number;
}

/** A member row with the fields only agents use. */
export interface AgentMember extends Member {
  scope?: Scope;
  budget?: Budget;
  last_action?: string;
  /** Present only after a live update; see useResponsible. */
  responsible_id?: string;
}

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

/** What every agent is doing right now, by user id. */
export function useAgentStates() {
  const slug = useSlug();
  return useLoad(
    () =>
      api.get<{ agents: AgentState[] }>(ws(slug, "/agents")).then((r) => {
        const out: Record<string, AgentState> = {};
        for (const a of r.agents) out[a.user_id] = a;
        return out;
      }),
    [slug],
  );
}

/**
 * Who answers for each agent, by the agent's user id. The workspace API
 * does not carry this on the member row, so it is read from the install's
 * user list, which only install admins may see; for anyone else the map is
 * empty and the pages say "not shown".
 */
export function useResponsible() {
  const isInstallAdmin = useSession((s) => !!s.user?.is_admin);
  return useLoad(async () => {
    const out: Record<string, string> = {};
    if (!isInstallAdmin) return out;
    const r = await api.get<{ users: { id: string; responsible_id?: string }[] }>("/api/v1/admin/users?kind=agent");
    for (const u of r.users) if (u.responsible_id) out[u.id] = u.responsible_id;
    return out;
  }, [isInstallAdmin]);
}

export const dollars = (micros: number | undefined) => (micros ? String(micros / 1_000_000) : "");

/** "12.50" → 12500000; "" → 0 (no limit); anything else → null. */
export function toMicros(text: string): number | null {
  const s = text.trim().replace(/^\$/, "");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
}

export function toMinutes(text: string): number | null {
  const s = text.trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

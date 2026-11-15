// What every agent is doing right now, read from the server and kept
// current, and from it whether something is listening for an agent's work.

import { useMemo } from "react";
import { useLive, useNow } from "@/data/live";
import { useLookup } from "@/data/selectors";
import type { Member } from "@/types/core";

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
  const members = useLookup("members");
  const now = useNow();
  return (member) => {
    if (!member || member.kind !== "agent") return undefined;
    const state = states.data?.[member.user_id];
    if (state) return state.listening;
    return (members[member.user_id]?.listening_until ?? 0) > now;
  };
}

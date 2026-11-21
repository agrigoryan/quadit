// What every agent is doing right now, read from the server and kept
// current, and from it whether something is listening for an agent's work
// and how far it is connected.

import { useMemo } from "react";
import { api, workspacePath } from "@/data/api";
import { liveKey, useLive } from "@/data/live";
import { queryClient } from "@/data/query";
import { getRow } from "@/data/selectors";
import { getState } from "@/data/store";
import type { Member } from "@/types/core";
import type { AgentState } from "@/types/dashboard";

/**
 * How far an agent is connected: it has never proven it reached Quadit from
 * inside its tool; it has, and works when asked there; or its listener
 * holds its lease (or a webhook pushes to it), so it will see what is
 * written here.
 */
export type Connection = "not_connected" | "connected" | "listening";

/**
 * Listening ends when a lease runs out, which no event tells: what is shown
 * is read again this often while it is on screen.
 */
const REREAD_MS = 20_000;

/** Fed by the same events as the Agents page: a member connecting is a member change. */
const FOLLOWS = ["member", "task", "session", "webhook", "decision"];

/**
 * What every agent is doing right now, by user id. It is the same reading
 * the Agents page shows (GET /agents, kept current as the feed moves and
 * read again while shown), so "Listening" means the same thing everywhere.
 */
export function useAgentStates(): { data: Record<string, AgentState> | undefined; error: string } {
  const live = useLive<{ agents: AgentState[] }>("/agents", { only: FOLLOWS, everyMs: REREAD_MS });
  const data = useMemo(() => {
    if (!live.data) return undefined;
    const out: Record<string, AgentState> = {};
    for (const a of live.data.agents) out[a.user_id] = a;
    return out;
  }, [live.data]);
  return { data, error: live.error };
}

/** How far an agent is connected, from its row (which the feed keeps current) and the server's reading. */
export function connectionOf(member: Member, state: AgentState | undefined): Connection {
  if (state?.listening) return "listening";
  return member.connected_at || state?.connected_at ? "connected" : "not_connected";
}

/**
 * How far each agent is connected, for what shows one (a task's assignee,
 * the comment box, the agents' pages). Undefined for a person, and for an
 * agent until the server has answered.
 */
export function useConnection(): (member: Member | undefined) => Connection | undefined {
  const states = useAgentStates();
  return (member) => {
    if (!member || member.kind !== "agent" || !states.data) return undefined;
    return connectionOf(member, states.data[member.user_id]);
  };
}

/**
 * Whether something is listening for a member's work, for lists where
 * people choose one. Undefined for people, and until the server answers:
 * the member row's own mark is not kept current, so it is not a guess.
 */
export function useListening(): (member: Member | undefined) => boolean | undefined {
  const connection = useConnection();
  return (member) => {
    const c = connection(member);
    return c === undefined ? undefined : c === "listening";
  };
}

/**
 * How far an agent (by user id) is connected, for a caller outside React
 * that asks often (the desktop app while a card waits): the server's
 * reading is shared with every page and asked again at most every few
 * seconds.
 */
export async function readConnection(agentId: string): Promise<Connection | undefined> {
  const member = getRow("members", agentId);
  if (!member || member.kind !== "agent") return undefined;
  const { slug } = getState();
  const answer = await queryClient.fetchQuery({
    queryKey: liveKey(slug, "/agents"),
    queryFn: ({ signal }) => api.get<{ agents: AgentState[] }>(workspacePath(slug, "/agents"), signal),
    staleTime: FRESH_ENOUGH_MS,
  });
  return connectionOf(
    member,
    answer.agents.find((a) => a.user_id === agentId),
  );
}

/** How old a reading readConnection hands out may be. */
const FRESH_ENOUGH_MS = 4_000;

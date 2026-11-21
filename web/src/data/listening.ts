// What every agent is doing right now, and how far each is connected, read
// from the server and kept current. What it is doing (GET /agents) is read
// again as the feed moves; how far it is connected (GET /agents/connection,
// a cheap read) also while something on screen shows it, since a
// listener's lease ends without an event.

import { useCallback, useMemo } from "react";
import { api, workspacePath } from "@/data/api";
import { liveKey, useLive } from "@/data/live";
import { queryClient } from "@/data/query";
import { getRow } from "@/data/selectors";
import { getState } from "@/data/store";
import type { Member } from "@/types/core";
import type { AgentConnection, AgentState } from "@/types/dashboard";

/**
 * How far an agent is connected: it has never proven it reached Quadit from
 * inside its tool; it has, and works when asked there; or its listener
 * holds its lease (or a webhook pushes to it), so it will see what is
 * written here.
 */
export type Connection = "not_connected" | "connected" | "listening";

/** How often what is shown of the agents' connection is read again while it is on screen. */
const REREAD_MS = 20_000;

const CONNECTION = "/agents/connection";

/**
 * What every agent is doing right now, by user id: the reading the Agents
 * page and the dashboard show, kept current as the feed moves. Its
 * listening is as fresh as the last event: what shows it asks
 * useFreshStates.
 */
export function useAgentStates(): { data: Record<string, AgentState> | undefined; error: string } {
  const live = useLive<{ agents: AgentState[] }>("/agents", {
    only: ["member", "task", "session", "webhook", "decision"],
  });
  const data = useMemo(() => byUser(live.data?.agents), [live.data]);
  return { data, error: live.error };
}

/** How far every agent is connected, by user id, read again while it is shown. */
function useAgentConnections(): Record<string, AgentConnection> | undefined {
  const live = useLive<{ agents: AgentConnection[] }>(CONNECTION, { only: ["member", "webhook"], everyMs: REREAD_MS });
  return useMemo(() => byUser(live.data?.agents), [live.data]);
}

function byUser<T extends { user_id: string }>(rows: T[] | undefined): Record<string, T> | undefined {
  if (!rows) return undefined;
  const out: Record<string, T> = {};
  for (const row of rows) out[row.user_id] = row;
  return out;
}

/**
 * A reading of what an agent is doing with how far it is connected brought
 * up to date, for what shows both (the Agents page, the dashboard,
 * Settings → Agents).
 */
export function useFreshStates(): (state: AgentState) => AgentState {
  const connections = useAgentConnections();
  return useCallback(
    (state: AgentState) => {
      const fresh = connections?.[state.user_id];
      return fresh
        ? { ...state, connected_at: fresh.connected_at, listening: fresh.listening, tool: fresh.tool }
        : state;
    },
    [connections],
  );
}

/** How far an agent is connected, from its row (which the feed keeps current) and the server's reading. */
export function connectionOf(
  member: Member,
  reading: Pick<AgentState, "connected_at" | "listening"> | undefined,
): Connection {
  if (reading?.listening) return "listening";
  return member.connected_at || reading?.connected_at ? "connected" : "not_connected";
}

/**
 * How far each agent is connected, and the tool it was last connected
 * from, for what shows it (a task's assignee, the comment box, a picker).
 * Undefined for a person, and for an agent until the server has answered.
 */
export function useConnection(): (member: Member | undefined) => { connection: Connection; tool?: string } | undefined {
  const connections = useAgentConnections();
  return (member) => {
    if (!member || member.kind !== "agent" || !connections) return undefined;
    const reading = connections[member.user_id];
    return { connection: connectionOf(member, reading), tool: reading?.tool };
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
    return c === undefined ? undefined : c.connection === "listening";
  };
}

/**
 * How far an agent (by user id) is connected, for a caller outside React
 * that asks often (the desktop app while a card waits): the cheap reading
 * is shared with every page and asked again at most every few seconds.
 */
export async function readConnection(agentId: string): Promise<Connection | undefined> {
  const member = getRow("members", agentId);
  if (!member || member.kind !== "agent") return undefined;
  const { slug } = getState();
  const answer = await queryClient.fetchQuery({
    queryKey: liveKey(slug, CONNECTION),
    queryFn: ({ signal }) => api.get<{ agents: AgentConnection[] }>(workspacePath(slug, CONNECTION), signal),
    staleTime: FRESH_ENOUGH_MS,
  });
  return connectionOf(
    member,
    answer.agents.find((a) => a.user_id === agentId),
  );
}

/** How old a reading readConnection hands out may be. */
const FRESH_ENOUGH_MS = 4_000;

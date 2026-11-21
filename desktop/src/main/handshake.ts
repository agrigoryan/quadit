// Where a tool Connect set up stands with Quadit (desktop contract §11):
// written on disk is not connected. The agent proves it reached Quadit by
// giving back, from inside the tool, a connect code the app made for it
// (`quadit connect CODE`); the server then counts it connected, and says
// whether it listens. This is how the app reads the server's answer about
// the agent (an agent-state request) into the card's state.

import type { Answer } from "@/main/requests";
import type { ConnectMethod, Handshake } from "@/shared/pages-api";

/** How long a connect code is good for: the server keeps one open for seven days. */
export const CODE_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** A connect code the app keeps for a connection (its ledger), so that its line can be shown again; `at` is when it was made (ms). */
export interface OpenCode {
  id: string;
  code: string;
  at: number;
}

/**
 * Where a connection stands at `now`, from the server's answer about its
 * agent. With a code still open it is connected once that code was given
 * back: proof from inside this tool, not from wherever else the agent
 * worked. Without one (it ran out, or an older version of the app connected
 * the tool), once the server counts the agent connected. Only a connection
 * through the quadit command waits for a code: by MCP alone there is no
 * command to give one back with.
 */
export function handshakeOf(
  connection: { methods: ConnectMethod[]; code: OpenCode | null },
  answer: Answer,
  now: number,
): Handshake {
  if (!answer.ok || typeof answer.connected !== "boolean") return { state: "unknown" };
  const open = connection.code && now - connection.code.at < CODE_LIFE_MS ? connection.code : null;
  if (answer.codeUsed === true || (!open && answer.connected))
    return { state: "connected", listening: answer.listening === true };
  if (!connection.methods.includes("cli")) return { state: "unknown" };
  return { state: "waiting", code: open?.code ?? null };
}

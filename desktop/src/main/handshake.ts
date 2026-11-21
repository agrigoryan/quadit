// Where a tool Connect set up stands with Quadit (desktop contract §11):
// written on disk is not connected. The agent proves it reached Quadit by
// giving back, from inside the tool, a connect code the app made for it
// (`quadit connect CODE`); the server then counts it connected, and says
// whether it listens. This is how the app reads the server's answer about
// the agent (an agent-state request) into the card's state.

import type { Answer } from "@/main/requests";
import { isConnectCode } from "@/shared/bridge";
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
 * agent; `before` is what the last answer made of it.
 *
 * With a code still open it waits until that code was given back: proof
 * from inside this tool, not from wherever else the agent worked. No answer
 * changes nothing (a closed window, a lost connection, an older server that
 * says nothing of agents): a waiting card is never made connected for want
 * of one. A code gone or run out is none. Without one (and for a tool an
 * older version of the app connected) it is connected only when the server
 * says the agent is; else it waits for a new code. Only a connection through
 * the quadit command waits for a code: by MCP alone there is no command to
 * give one back with.
 */
export function handshakeOf(
  connection: { methods: ConnectMethod[]; code: OpenCode | null },
  answer: Answer,
  now: number,
  before: Handshake | undefined,
): Handshake {
  const { code } = connection;
  const open = code && now - code.at < CODE_LIFE_MS && isConnectCode(code.code) ? code : null;
  if (!answer.ok || typeof answer.connected !== "boolean") {
    if (open) return { state: "waiting", code: open.code };
    if (before?.state === "waiting") return { state: "waiting", code: null };
    return before ?? { state: "unknown" };
  }
  if (answer.codeUsed === true) return { state: "connected", listening: answer.listening === true };
  if (open && answer.codeGone !== true) return { state: "waiting", code: open.code };
  if (answer.connected) return { state: "connected", listening: answer.listening === true };
  if (!connection.methods.includes("cli")) return { state: "unknown" };
  return { state: "waiting", code: null };
}

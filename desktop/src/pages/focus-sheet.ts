// What Connect agents shows when a page opened it at one of its agents (its
// focus, connect-page.ts): a sheet of that agent alone, laid over the page
// as its dialog, rather than the whole page. Decided here, apart from the
// page's nodes; connect.ts shows it.

import type { ConnectFocusView } from "@/shared/pages-api";

/** A tool as the page shows it: found here, set up here, and whether it works as this computer's default login. */
export interface SheetTool {
  id: string;
  found: boolean;
  setUp: boolean;
  defaultLogin: boolean;
}

/**
 * The sheet: the cards it holds (by tool), the line above them, what the
 * page meant (`intent`), and, when no tool works as the agent here, the
 * agent a Connect makes one work as.
 */
export interface Sheet {
  tools: string[];
  line: string | null;
  intent: "connect" | "run" | "disconnect";
  connectAs: { id: string; handle: string } | null;
}

/**
 * The sheet for `focus`: the card of the tool that works as its agent, for
 * any intent; with none, and to connect, the line saying the agent and the
 * cards that could work as it (found, not set up, and not working as this
 * computer's default login); else none, and the whole page is shown.
 * `here` is what the page calls this computer.
 */
export function sheetOf(focus: ConnectFocusView | undefined, tools: SheetTool[], here: string): Sheet | null {
  if (!focus) return null;
  const intent = focus.intent ?? "connect";
  if (focus.tool && tools.some((t) => t.id === focus.tool))
    return { tools: [focus.tool], line: null, intent, connectAs: null };
  if (intent !== "connect" || !focus.agent) return null;
  const could = tools.filter((t) => t.found && !t.setUp && !t.defaultLogin).map((t) => t.id);
  const { handle } = focus.agent;
  return {
    tools: could,
    line:
      could.length > 0
        ? `Choose what should work as @${handle} on ${here}.`
        : `No AI tool found on ${here} is free to work as @${handle}.`,
    intent,
    connectAs: focus.agent,
  };
}

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
 * The sheet: its title (the agent's name, with its handle beside it; null:
 * the page's own), the cards it holds (by tool), the line above them, what
 * the page meant (`intent`), and, when no tool works as the agent here, the
 * agent a Connect makes one work as.
 */
export interface Sheet {
  title: { name: string; handle: string | null } | null;
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
 * `here` is what the page calls this computer; `agents`, the workspace's
 * agents as its window's page published them, which give the agent's name.
 */
export function sheetOf(
  focus: ConnectFocusView | undefined,
  tools: SheetTool[],
  here: string,
  agents: { id: string; name: string; handle: string }[] = [],
): Sheet | null {
  if (!focus) return null;
  const intent = focus.intent ?? "connect";
  const title = titleOf(focus, agents);
  if (focus.tool && tools.some((t) => t.id === focus.tool))
    return { title, tools: [focus.tool], line: null, intent, connectAs: null };
  if (intent !== "connect" || !focus.agent) return null;
  const could = tools.filter((t) => t.found && !t.setUp && !t.defaultLogin).map((t) => t.id);
  const { handle } = focus.agent;
  return {
    title,
    tools: could,
    line:
      could.length > 0
        ? `Choose what should work as @${handle} on ${here}.`
        : `No AI tool found on ${here} is free to work as @${handle}.`,
    intent,
    connectAs: focus.agent,
  };
}

/** The sheet's title: the agent's name and handle, else "@handle", else none (the page's own title). */
function titleOf(focus: ConnectFocusView, agents: { id: string; name: string; handle: string }[]): Sheet["title"] {
  const handle = focus.agent?.handle;
  if (!handle) return null;
  const name = agents.find((a) => a.id === focus.agent?.id)?.name.trim();
  return name ? { name, handle: `@${handle}` } : { name: `@${handle}`, handle: null };
}

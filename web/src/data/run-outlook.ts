// What will happen, for each agent a computer runs, to a comment a member is
// about to write on a task or to assigning it the task (GET
// /tasks/{ref}/run-outlook): it starts now, waits its turn, waits for the
// computer, is paused, or will not start. Read again as runs, inbox items
// and members change, and while it is shown, since a runner going away
// makes no event.

import { useMemo } from "react";
import { useLive } from "@/data/live";
import type { RunOutlook } from "@/types/dashboard";

/** What the member is about to do: write a comment, or assign the task. */
export type RunCause = "comment" | "assign";

/** How often a shown outlook is read again. */
const REREAD_MS = 20_000;

/**
 * The outlook for each agent named (handles, with or without @), by handle
 * with its @; undefined until the server answers, with nothing to ask (no
 * task, no agent), and while the read fails: an earlier answer may no
 * longer hold, and what it promised is not said. An agent the server does
 * not know is left out.
 */
export function useRunOutlook(
  taskKey: string | undefined,
  agents: string[],
  cause: RunCause,
): { outlooks: Record<string, RunOutlook> | undefined; error: string } {
  // One path for the same set, whatever order the agents come in, so pages asking alike share one answer.
  const asked = [...new Set(agents.map((a) => (a.startsWith("@") ? a : `@${a}`)))].sort().join(",");
  const path =
    taskKey && asked
      ? `/tasks/${encodeURIComponent(taskKey)}/run-outlook?agents=${encodeURIComponent(asked)}&cause=${cause}`
      : null;
  const live = useLive<{ outlooks: RunOutlook[] }>(path, {
    only: ["session", "notification", "member"],
    everyMs: REREAD_MS,
  });
  const outlooks = useMemo(
    () => (live.data ? Object.fromEntries(live.data.outlooks.map((o) => [o.agent, o])) : undefined),
    [live.data],
  );
  return { outlooks: path && !live.error ? outlooks : undefined, error: live.error };
}

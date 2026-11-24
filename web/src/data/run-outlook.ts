// What will happen, for each agent a computer runs, to a comment a member is
// about to write on a task or to assigning it the task (GET
// /tasks/{ref}/run-outlook): it starts now, waits its turn, waits for the
// computer, is paused, or will not start. Read again as runs, inbox items
// and members change (and, for assigning, tasks: someone else may assign
// it), and while it is shown, since a runner going away makes no event.

import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { api, workspacePath } from "@/data/api";
import { liveKey, useFollowFeed } from "@/data/live";
import { readError } from "@/data/query";
import { useSlug } from "@/data/selectors";
import type { RunOutlook } from "@/types/dashboard";

/** What the member is about to do: write a comment, or assign the task. */
export type RunCause = "comment" | "assign";

/** How often a shown outlook is read again. */
const REREAD_MS = 20_000;

/** How many agents the server answers about in one read. */
const PER_READ = 20;

/**
 * The outlook for each agent named (handles, with or without @), by handle
 * with its @, asked in reads of at most 20 agents. An agent has none until
 * its read is answered, and none while its read fails: an earlier answer
 * may no longer hold, and what it promised is not said. Nothing is asked
 * without a task or an agent. An agent the server does not know is left
 * out. `error` says why a read failed, or is "".
 */
export function useRunOutlook(
  taskKey: string | undefined,
  agents: string[],
  cause: RunCause,
): { outlooks: Record<string, RunOutlook>; error: string } {
  const slug = useSlug();
  // The same paths for the same set, whatever order the agents come in, so pages asking alike share the answers.
  const asked = [...new Set(agents.map((a) => (a.startsWith("@") ? a : `@${a}`)))].sort();
  const paths: string[] = [];
  for (let i = 0; taskKey && i < asked.length; i += PER_READ) {
    const group = asked.slice(i, i + PER_READ).join(",");
    paths.push(`/tasks/${encodeURIComponent(taskKey)}/run-outlook?agents=${encodeURIComponent(group)}&cause=${cause}`);
  }
  const read = useQueries({
    queries: paths.map((path) => ({
      queryKey: liveKey(slug, path),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<{ outlooks: RunOutlook[] }>(workspacePath(slug, path), signal),
      refetchInterval: REREAD_MS,
    })),
    combine,
  });
  useFollowFeed(paths, { only: ["session", "notification", "member", ...(cause === "assign" ? ["task"] : [])] });
  return read;
}

/** The reads' answers as one lookup by agent, leaving out every agent of a read that failed. */
function combine(reads: UseQueryResult<{ outlooks: RunOutlook[] }>[]) {
  const outlooks: Record<string, RunOutlook> = {};
  for (const read of reads) if (!read.error) for (const o of read.data?.outlooks ?? []) outlooks[o.agent] = o;
  return { outlooks, error: reads.map((read) => readError(read.error)).find(Boolean) ?? "" };
}

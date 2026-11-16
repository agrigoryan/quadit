// Looking up a task the store does not hold. The starting copy leaves out
// what is in the trash, and the finished work (done, canceled, archived)
// arrives a while after the rest; a task's page, a relation's row or a
// mention in a text that names one of those asks the server for it here, and
// the answer goes into the store, where the feed keeps it current. The server
// also knows the keys a task had before it moved to another project, so a key
// written before the move still finds the task, under its new key.

import { useQueries, useQuery } from "@tanstack/react-query";
import { api, workspacePath } from "@/data/api";
import { isNotFound, readError } from "@/data/query";
import { useLookupEvenIfGone, useRowEvenIfGone, useSlug, useTaskByKeyEvenIfGone } from "@/data/selectors";
import { mergeRows } from "@/data/store";
import { taskKeys } from "@/data/task-detail";
import type { Task } from "@/types/core";

/** The task a key names, and where the look for it stands when the store does not have it. */
export interface FindTask {
  /** The task, trashed and archived ones too. Its key differs from the one asked for when it has moved since. */
  task: Task | undefined;
  /** True while the answer is on its way. */
  looking: boolean;
  /** Why the server could not answer, or "". A task that is not there is not an error. */
  error: string;
  retry: () => void;
}

/**
 * Fetches a task (by key, a former key, or id) into the store and gives its
 * id; null when the server says there is no such task, or none for this
 * person.
 */
async function fetchTaskRow(slug: string, keyOrId: string, signal: AbortSignal): Promise<string | null> {
  try {
    const raw = await api.get<{ task: Task }>(
      workspacePath(slug, `/tasks/${encodeURIComponent(keyOrId)}?raw=1`),
      signal,
    );
    mergeRows("tasks", [raw.task]);
    return raw.task.id;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * The task with this key: from the store, or else asked of the server
 * (unless `ask` is false: a mention waits for the finished work to arrive
 * before it asks). A failed look is tried again when the live stream comes
 * back.
 */
export function useFindTask(taskKey: string, ask = true): FindTask {
  const slug = useSlug();
  const here = useTaskByKeyEvenIfGone(taskKey);
  const found = useQuery({
    queryKey: taskKeys.row(slug, taskKey),
    queryFn: ({ signal }) => fetchTaskRow(slug, taskKey, signal),
    enabled: ask && !here,
  });
  // Found under a former key, the task is in the store by its id.
  const moved = useRowEvenIfGone("tasks", here ? undefined : (found.data ?? undefined));
  const task = here ?? moved;
  const error = task || !ask ? "" : readError(found.error);
  // A 401 is no answer: the person is on the way to sign in.
  const looking = !task && ask && (found.isPending || (!!found.error && !error));
  return { task, looking, error, retry: () => void found.refetch() };
}

/**
 * Fetches tasks the store does not hold yet, by id, so a row that names one
 * can be drawn. Each is asked for once; one that failed is asked again when
 * the stream comes back, or when a row that names it is drawn again.
 */
export function useEnsureTasks(ids: string[]) {
  const slug = useSlug();
  const tasks = useLookupEvenIfGone("tasks");
  useQueries({
    queries: ids
      .filter((id) => !tasks[id])
      .map((id) => ({
        queryKey: taskKeys.row(slug, id),
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchTaskRow(slug, id, signal),
        // Once there, the task is in the store and the feed keeps it current.
        staleTime: Infinity,
      })),
  });
}

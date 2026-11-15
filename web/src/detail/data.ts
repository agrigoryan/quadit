// What the task panel reads from the store beyond the task itself: its
// sub-tasks, relations, links and files, and how a person or agent is named
// in a sentence.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, workspacePath } from "@/lib/api";
import { t } from "@/lib/i18n";
import { isNotFound, readError } from "@/lib/query";
import { getRowEvenIfGone, sortByRank, useLookupEvenIfGone, useRows, useSlug } from "@/lib/selectors";
import { type Dict, mergeRows } from "@/lib/store";
import { taskKeys } from "@/lib/task-detail";
import type { Attachment, FileRow, Member, Relation, SubjectType, Task, TaskLink } from "@/lib/types";

/** An attachment whose file is known (every one the panel draws). */
export type Attached = Attachment & { file: FileRow };

/** Where the look for a task the store does not have stands. */
export interface FindTask {
  /** True while the answer is on its way. */
  looking: boolean;
  /** Why the server could not answer, or "". A task that is not there is not an error. */
  error: string;
  retry: () => void;
}

/**
 * Fetches a task (by key or id) into the store. True when it was there; false
 * when the server says there is no such task, or none for this person.
 */
async function fetchTaskRow(slug: string, keyOrId: string, signal: AbortSignal): Promise<boolean> {
  try {
    const raw = await api.get<{ task: Task }>(
      workspacePath(slug, `/tasks/${encodeURIComponent(keyOrId)}?raw=1`),
      signal,
    );
    mergeRows("tasks", [raw.task]);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Asks the server for a task the store does not have: one in the trash, which
 * the starting copy leaves out. A failed look is tried again when the live
 * stream comes back.
 */
export function useFindTask(taskKey: string, have: boolean): FindTask {
  const slug = useSlug();
  const found = useQuery({
    queryKey: taskKeys.row(slug, taskKey),
    queryFn: ({ signal }) => fetchTaskRow(slug, taskKey, signal),
    enabled: !have,
  });
  const error = have ? "" : readError(found.error);
  // A 401 is no answer: the person is on the way to sign in.
  const looking = !have && (found.isPending || (!!found.error && !error));
  return { looking, error, retry: () => void found.refetch() };
}

export function useSubtasks(taskId: string): Task[] {
  const tasks = useRows("tasks");
  return useMemo(() => sortByRank(tasks.filter((tk) => tk.parent_id === taskId)), [tasks, taskId]);
}

export function useTaskRelations(taskId: string): Relation[] {
  const relations = useRows("relations");
  return useMemo(
    () => relations.filter((r) => r.task_id === taskId || r.related_task_id === taskId),
    [relations, taskId],
  );
}

export function useTaskLinks(taskId: string): TaskLink[] {
  const links = useRows("links");
  return useMemo(
    () => links.filter((l) => l.task_id === taskId).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [links, taskId],
  );
}

const hasFile = (a: Attachment): a is Attached => !!a.file;

/** Live attachments of one kind of subject, grouped by the subject they are on, in order. */
export function useAttachmentsBySubject(subjectType: SubjectType): Dict<Attached[]> {
  const attachments = useRows("attachments");
  return useMemo(() => {
    const out: Dict<Attached[]> = {};
    for (const a of sortByRank(attachments)) {
      if (a.subject_type === subjectType && hasFile(a)) (out[a.subject_id] ??= []).push(a);
    }
    return out;
  }, [attachments, subjectType]);
}

const NO_FILES: Attached[] = [];

export function useTaskAttachments(taskId: string): Attached[] {
  return useAttachmentsBySubject("task")[taskId] ?? NO_FILES;
}

/** How someone is named in a sentence: a person by name, an agent by handle. */
export function nameOf(member: Member | undefined): string {
  if (!member) return t("common.someone");
  return member.kind === "agent" ? `@${member.handle}` : member.name;
}

/** A member removed from the workspace is still named. */
export const who = (userId: string | undefined) => nameOf(getRowEvenIfGone("members", userId));

/** A relation as seen from one task. */
export type Side = "blocks" | "blockedBy" | "relates" | "duplicates" | "duplicatedBy";

/** Which way a stored relation reads from `taskId`, and the task at the other end. */
export function sideOf(
  r: Pick<Relation, "task_id" | "related_task_id" | "type">,
  taskId: string,
): { side: Side; otherId: string } {
  const mine = r.task_id === taskId;
  const otherId = mine ? r.related_task_id : r.task_id;
  if (r.type === "blocks") return { side: mine ? "blocks" : "blockedBy", otherId };
  if (r.type === "duplicates") return { side: mine ? "duplicates" : "duplicatedBy", otherId };
  return { side: "relates", otherId };
}

/** What a link is called: its title, else what it points at. */
export function linkName(link: Pick<TaskLink, "kind" | "title" | "ref" | "repo" | "url">): string {
  if (link.title) return link.title;
  if (link.kind === "pr" && link.ref) return `${link.repo ? `${link.repo} ` : ""}#${link.ref}`;
  if (link.kind === "commit" && link.ref) return link.ref.slice(0, 8);
  if (link.ref) return link.ref;
  return (link.url ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/**
 * Fetches tasks the store does not hold yet (closed ones arrive later than
 * the rest; one may be in the trash), so a row that names one can be drawn.
 * Each is asked for once; one that failed is asked again when the stream
 * comes back, or when a row that names it is drawn again.
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

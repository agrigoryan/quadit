// What the task panel reads from the store beyond the task itself: its
// sub-tasks, relations, links and files, and how a person or agent is named
// in a sentence.

import { useEffect, useMemo, useState } from "react";
import { api, workspacePath } from "@/lib/api";
import { t } from "@/lib/i18n";
import { sortByRank, useCollection } from "@/lib/selectors";
import { type Dict, getState, mergeRows, useStore } from "@/lib/store";
import type { Attachment, FileRow, Member, Relation, SubjectType, Task, TaskLink } from "@/lib/types";

/** An attachment whose file is known (every one the panel draws). */
export type Attached = Attachment & { file: FileRow };

/**
 * Asks the server for a task the store does not have: one in the trash, which
 * the starting copy leaves out. True while the answer is on its way.
 */
export function useFindTask(taskKey: string, have: boolean): boolean {
  const [looking, setLooking] = useState(!have);
  useEffect(() => {
    if (have) return;
    let current = true;
    setLooking(true);
    api
      .get<{ task: Task }>(workspacePath(getState().slug, `/tasks/${encodeURIComponent(taskKey)}?raw=1`))
      .then((raw) => mergeRows("tasks", [raw.task]))
      .catch(() => {})
      .finally(() => current && setLooking(false));
    return () => {
      current = false;
    };
  }, [taskKey, have]);
  return looking && !have;
}

export function useSubtasks(taskId: string): Task[] {
  const tasks = useCollection("tasks");
  return useMemo(
    () => sortByRank(Object.values(tasks).filter((tk) => tk.parent_id === taskId && !tk.deleted_at)),
    [tasks, taskId],
  );
}

export function useTaskRelations(taskId: string): Relation[] {
  const relations = useCollection("relations");
  return useMemo(
    () => Object.values(relations).filter((r) => r.task_id === taskId || r.related_task_id === taskId),
    [relations, taskId],
  );
}

export function useTaskLinks(taskId: string): TaskLink[] {
  const links = useCollection("links");
  return useMemo(
    () =>
      Object.values(links)
        .filter((l) => l.task_id === taskId && !l.deleted_at)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    [links, taskId],
  );
}

const hasFile = (a: Attachment): a is Attached => !a.deleted_at && !!a.file;

/** Live attachments of one kind of subject, grouped by the subject they are on, in order. */
export function useAttachmentsBySubject(subjectType: SubjectType): Dict<Attached[]> {
  const attachments = useCollection("attachments");
  return useMemo(() => {
    const out: Dict<Attached[]> = {};
    for (const a of sortByRank(Object.values(attachments))) {
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

export const who = (userId: string | undefined) => nameOf(userId ? getState().collections.members[userId] : undefined);

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

const asked = new Set<string>();

/**
 * Fetches tasks the store does not hold yet (closed ones arrive later than
 * the rest; one may be in the trash), so a row that names one can be drawn.
 */
export function useEnsureTasks(ids: string[]) {
  const missing = useStore((s) => ids.filter((id) => !s.collections.tasks[id]).join(","));
  useEffect(() => {
    for (const id of missing ? missing.split(",") : []) {
      if (asked.has(id)) continue;
      asked.add(id);
      api
        .get<{ task: Task }>(workspacePath(getState().slug, `/tasks/${id}?raw=1`))
        .then((raw) => mergeRows("tasks", [raw.task]))
        .catch(() => {});
    }
  }, [missing]);
}

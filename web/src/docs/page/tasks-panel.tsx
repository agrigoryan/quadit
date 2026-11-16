// "Tasks" under a page: the tasks linked to it (from the task, or with
// `quadit link`), those whose text or comments mention it, and those it
// mentions, each once and each a link to the task. A task is linked here
// too, and a linked one taken off. The server sends only what the reader may
// see.

import { useCallback, useMemo } from "react";
import { Plus, X } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import { getRow, useLookup, useLookupEvenIfGone, useMember, useRows } from "@/data/selectors";
import type { Task } from "@/types/core";
import { TaskPicker } from "@/detail/task-picker";
import { unlinkTask } from "@/docs/actions";
import { useDocsStore } from "@/docs/store";
import { useTaskLink } from "@/nav/task-link";
import { linkPage } from "@/tasks/actions";
import { MemberCard } from "@/tasks/member-card";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";

/** One task beside the page, and how it got there. */
export interface PageTask {
  task: Task;
  /** The link that ties it to the page, when one does; only such a task can be taken off. */
  linkId?: string;
  /** Why it is listed when it is not linked. */
  how?: "mentionsPage" | "mentionedHere";
}

const NONE: never[] = [];

/** The page's tasks, each once: linked first, then those that mention the page, then those it mentions. */
export function usePageTasks(docId: string): PageTask[] {
  const mentionedIn = useDocsStore((s) => s.meta[docId]?.mentioned_in) ?? NONE;
  const mentions = useDocsStore((s) => s.meta[docId]?.mentions) ?? NONE;
  // Links made or taken off since the page was read come with the copy.
  const links = useRows("links");
  const everyLink = useLookupEvenIfGone("links");
  const tasks = useLookup("tasks");
  return useMemo(() => {
    const seen = new Map<string, PageTask>();
    const add = (taskId: string, how: Omit<PageTask, "task">) => {
      const task = tasks[taskId];
      if (task && !seen.has(task.id)) seen.set(task.id, { task, ...how });
    };
    const fromTasks = mentionedIn.filter((ref) => ref.from_scope_type === "task");
    // A task both linked and mentioned is listed as linked, so that it can be taken off.
    for (const link of links) if (link.kind === "doc" && link.ref === docId) add(link.task_id, { linkId: link.id });
    for (const ref of fromTasks) {
      if (ref.from_type === "link" && !everyLink[ref.from_id]?.deleted_at)
        add(ref.from_scope_id, { linkId: ref.from_id });
    }
    for (const ref of fromTasks) if (ref.from_type !== "link") add(ref.from_scope_id, { how: "mentionsPage" });
    for (const ref of mentions) if (ref.to_type === "task") add(ref.to_id, { how: "mentionedHere" });
    return [...seen.values()];
  }, [links, everyLink, mentionedIn, mentions, tasks, docId]);
}

function TaskRow({ row }: { row: PageTask }) {
  const { task, linkId, how } = row;
  const status = useLookup("statuses")[task.status_id];
  const link = useTaskLink(task);
  const mayUnlink = useCan().editTask(task);
  const assignee = useMember(task.assignee_id);
  return (
    <li className="group relative -mx-1.5 flex h-8 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-hover max-md:h-10">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {status && <StatusIcon category={status.category} title={status.name} />}
      </span>
      <span className="shrink-0 text-xs text-ink-3 tnum">{task.key}</span>
      <Link
        {...link}
        className="min-w-0 flex-1 truncate py-1.5 outline-none after:absolute after:inset-0 after:content-['']"
      >
        {task.title}
      </Link>
      {how && <span className="shrink-0 text-xs text-ink-3 max-sm:hidden">{t(`docs.tasks.${how}`)}</span>}
      {assignee ? (
        <MemberCard member={assignee}>
          <button type="button" className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm">
            <Avatar member={assignee} size="sm" />
          </button>
        </MemberCard>
      ) : (
        <Avatar member={undefined} size="sm" />
      )}
      {linkId && mayUnlink && (
        <IconButton
          label={t("docs.tasks.remove", { key: task.key })}
          size="sm"
          className="relative z-[1] shrink-0 text-ink-3 max-md:size-8"
          // Safe to drop: it never rejects, and a refusal is shown, and undone, by mutate.
          onClick={() => void unlinkTask(linkId)}
        >
          <X className="size-3" />
        </IconButton>
      )}
    </li>
  );
}

/**
 * The page's "Tasks" panel, with the way to link a task. Draws nothing when
 * no task points at the page or is named in it and none can be linked.
 */
export function TasksPanel({ docId }: { docId: string }) {
  const rows = usePageTasks(docId);
  const can = useCan();
  const listed = useMemo(() => new Set(rows.map((row) => row.task.id)), [rows]);
  const offered = useCallback((task: Task) => can.editTask(task) && !listed.has(task.id), [can, listed]);
  const tasks = useRows("tasks");
  const mayAdd = tasks.some(offered);
  if (rows.length === 0 && !mayAdd) return null;
  return (
    <section aria-label={t("docs.tasks")} className="mt-8 border-t border-line pt-3">
      <div className="flex h-7 items-center gap-2">
        <h2 className="text-xs font-medium text-ink-2">
          {t("docs.tasks")} {rows.length > 0 && <span className="font-normal text-ink-3 tnum">{rows.length}</span>}
        </h2>
        <span className="flex-1" />
        {mayAdd && (
          <TaskPicker filter={offered} label={t("docs.tasks.add")} onPick={(taskId) => linkTask(taskId, docId)}>
            <IconButton label={t("docs.tasks.add")} size="sm" className="max-md:size-9">
              <Plus className="size-3.5" />
            </IconButton>
          </TaskPicker>
        )}
      </div>
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <TaskRow key={row.task.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Links a task to the page, the way the task's own "Add a page" does. */
function linkTask(taskId: string, docId: string) {
  const task = getRow("tasks", taskId);
  if (task) linkPage(task, docId);
}

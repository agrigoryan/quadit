// Everything under a task's header: title, description, properties, the
// sections, the timeline. In the panel it is one column. On the task's own
// page, where there is the width for it, the properties stand at the side
// and the description and timeline take the rest.

import { useRef, useState } from "react";
import { GitFork, Link2, ListTree, Paperclip } from "lucide-react";
import { DecisionSection } from "@/decisions/decision-section";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Task } from "@/lib/types";
import { Attachments } from "@/detail/attachments";
import { useSubtasks, useTaskAttachments, useTaskLinks, useTaskRelations } from "@/detail/data";
import { Links } from "@/detail/links";
import { MentionedIn } from "@/detail/mentions";
import { Properties } from "@/detail/properties";
import { Relations } from "@/detail/relations";
import { Subtasks } from "@/detail/subtasks";
import { Timeline } from "@/detail/timeline";
import { Description, EditableTitle } from "@/detail/title-description";
import { attachToTask, type PendingUpload, useUploads } from "@/detail/uploads";
import { plainLinks, TaskWork } from "@/insights/task-work";
import { Button } from "@/ui/button";

/** Where the task is shown: the panel over a list, or its own page. */
export type TaskLayout = "panel" | "page";

type Extra = "subtasks" | "relations" | "links";
const NO_UPLOADS: PendingUpload[] = [];

interface Props {
  task: Task;
  /** "loading", "ready", or what went wrong fetching the task's details. */
  status: string;
  layout: TaskLayout;
}

export function TaskBody({ task, status, layout }: Props) {
  const subtasks = useSubtasks(task.id);
  const relations = useTaskRelations(task.id);
  // Branches, commits and pull requests are drawn by TaskWork; Links keeps the plain addresses.
  const links = plainLinks(useTaskLinks(task.id));
  const files = useTaskAttachments(task.id);
  const pending = useUploads((s) => s.pending[task.id]) ?? NO_UPLOADS;
  const chooser = useRef<HTMLInputElement>(null);
  // Sections with nothing in them stay out of the way until asked for.
  const [opened, setOpened] = useState<Partial<Record<Extra, boolean>>>({});
  const open = (name: Extra) => setOpened((o) => ({ ...o, [name]: true }));
  const close = (name: Extra) => setOpened((o) => ({ ...o, [name]: false }));

  const loading = status === "loading";
  const failed = status !== "loading" && status !== "ready";
  const readOnly = !!task.deleted_at;
  const page = layout === "page";
  const show = {
    subtasks: subtasks.length > 0 || !!opened.subtasks,
    relations: relations.length > 0 || !!opened.relations,
    links: links.length > 0 || !!opened.links,
    files: files.length > 0 || pending.length > 0,
  };
  const attach = () => chooser.current?.click();
  const adders = [
    { on: !show.subtasks, icon: ListTree, label: t("detail.add.subtask"), run: () => open("subtasks") },
    { on: !show.relations, icon: GitFork, label: t("detail.add.relation"), run: () => open("relations") },
    { on: !show.links, icon: Link2, label: t("detail.add.link"), run: () => open("links") },
    { on: !show.files, icon: Paperclip, label: t("detail.add.attach"), run: attach },
  ].filter((a) => a.on && !readOnly);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <input
        ref={chooser}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          attachToTask(task, [...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {/* One column; on a wide page two, the properties in the second from top to bottom. */}
      <div
        className={cx(
          page &&
            "mx-auto max-w-[78rem] lg:grid lg:min-h-full lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-[auto_1fr]",
        )}
      >
        <div className={cx("px-4 pt-4 pb-3 md:px-6", page && "lg:px-10 lg:pt-7 lg:pb-5")}>
          <EditableTitle task={task} large={page} />
          <Description task={task} loading={loading} />
          {failed && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {t("detail.loadFailed")}: {status}
            </p>
          )}
        </div>

        <div className={cx(page && "lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-line")}>
          <Properties task={task} side={page} />
        </div>

        <div className={cx(page && "lg:col-start-1 lg:px-4")}>
          {adders.length > 0 && (
            <div className="flex flex-wrap gap-1 border-t border-line px-2.5 py-1.5 md:px-4.5">
              {adders.map((a) => (
                <Button key={a.label} variant="ghost" size="sm" className="max-md:h-9 max-md:px-2.5" onClick={a.run}>
                  <a.icon className="size-3.5" aria-hidden />
                  {a.label}
                </Button>
              ))}
            </div>
          )}

          <div className="empty:hidden">
            <DecisionSection taskId={task.id} />
          </div>

          {show.subtasks && (
            <Subtasks task={task} subtasks={subtasks} focusAdd={!!opened.subtasks && subtasks.length === 0} />
          )}
          {show.relations && (
            <Relations
              task={task}
              relations={relations}
              startAdding={!!opened.relations}
              onEmptyClose={() => close("relations")}
            />
          )}
          {show.links && (
            <Links task={task} links={links} startAdding={!!opened.links} onEmptyClose={() => close("links")} />
          )}
          <TaskWork task={task} />
          {show.files && <Attachments task={task} files={files} pending={pending} onAttach={attach} />}
          <MentionedIn task={task} />

          <Timeline task={task} loading={loading} />
        </div>
      </div>
    </div>
  );
}

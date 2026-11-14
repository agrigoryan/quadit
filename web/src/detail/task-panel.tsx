// A task, as a panel on the right over the list or board it was opened
// from. On a phone it covers the whole screen. This file lays the parts out
// and owns what they share: the file chooser, dropping files anywhere, and
// which empty sections have been opened to add a first item.

import { type DragEvent, useRef, useState } from "react";
import { GitFork, Link2, ListTree, Paperclip } from "lucide-react";
import { DecisionSection } from "@/decisions/decision-section";
import { useHotkeys } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useTaskByKey } from "@/lib/selectors";
import { useTaskDetail } from "@/lib/task-detail";
import type { Task } from "@/lib/types";
import { Attachments } from "@/detail/attachments";
import { useFindTask, useSubtasks, useTaskAttachments, useTaskLinks, useTaskRelations } from "@/detail/data";
import { Links } from "@/detail/links";
import { PanelHeader, TrashBanner } from "@/detail/panel-header";
import { Properties } from "@/detail/properties";
import { Relations } from "@/detail/relations";
import { Subtasks } from "@/detail/subtasks";
import { Timeline } from "@/detail/timeline";
import { Description, EditableTitle } from "@/detail/title-description";
import { attachToTask, carriesFiles, type PendingUpload, useUploads } from "@/detail/uploads";
import { plainLinks, TaskWork } from "@/insights/task-work";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

interface Props {
  taskKey: string;
  onClose: () => void;
}

type Extra = "subtasks" | "relations" | "links";
const NO_UPLOADS: PendingUpload[] = [];

export function TaskPanel({ taskKey, onClose }: Props) {
  const task = useTaskByKey(taskKey);
  const looking = useFindTask(taskKey, !!task);
  const status = useTaskDetail(task?.id);
  const [dragging, setDragging] = useState(false);
  const canDrop = !!task && !task.deleted_at;
  useHotkeys({ Escape: onClose }, { layer: "panel" });

  // dragenter and dragleave fire for every child crossed; count them to know when the drag has really left.
  const depth = useRef(0);
  function drag(e: DragEvent, step: 1 | -1) {
    if (!canDrop || !carriesFiles(e)) return;
    depth.current = Math.max(0, depth.current + step);
    setDragging(depth.current > 0);
  }
  function endDrag() {
    depth.current = 0;
    setDragging(false);
  }

  return (
    <aside
      data-task-panel
      aria-label={taskKey}
      onDragEnter={(e) => drag(e, 1)}
      onDragLeave={(e) => drag(e, -1)}
      onDragOver={(e) => canDrop && carriesFiles(e) && e.preventDefault()}
      onDropCapture={endDrag}
      onDrop={(e) => {
        if (!task || !canDrop || !carriesFiles(e)) return;
        e.preventDefault();
        attachToTask(task, [...e.dataTransfer.files]);
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col bg-surface shadow-panel animate-panel md:w-[min(44rem,calc(100vw-3rem))]"
    >
      <PanelHeader taskKey={taskKey} task={task} onClose={onClose} />
      {!task ? (
        looking ? (
          <Loading />
        ) : (
          <EmptyState title={t("common.notFound")} hint={t("common.notFoundHint")} />
        )
      ) : (
        <>
          {!!task.deleted_at && <TrashBanner task={task} />}
          <PanelBody task={task} status={status} />
        </>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-start justify-center rounded-lg border-2 border-dashed border-accent pt-14">
          <span className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-ink shadow-pop">{t("detail.files.drop")}</span>
        </div>
      )}
    </aside>
  );
}

function PanelBody({ task, status }: { task: Task; status: string }) {
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
      <div className="px-4 pt-4 pb-3 md:px-6">
        <EditableTitle task={task} />
        <Description task={task} loading={loading} />
        {failed && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {t("detail.loadFailed")}: {status}
          </p>
        )}
      </div>

      <Properties task={task} />

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

      {show.subtasks && <Subtasks task={task} subtasks={subtasks} focusAdd={!!opened.subtasks && subtasks.length === 0} />}
      {show.relations && (
        <Relations task={task} relations={relations} startAdding={!!opened.relations} onEmptyClose={() => close("relations")} />
      )}
      {show.links && <Links task={task} links={links} startAdding={!!opened.links} onEmptyClose={() => close("links")} />}
      <TaskWork task={task} />
      {show.files && <Attachments task={task} files={files} pending={pending} onAttach={attach} />}

      <Timeline task={task} loading={loading} />
    </div>
  );
}

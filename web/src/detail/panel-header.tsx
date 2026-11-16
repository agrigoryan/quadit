// The top of a task, in the panel and on its own page: where the task
// lives, and what can be done to it as a whole (watch, copy its link, move
// it to the trash, open it as a page, close or go back).

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Link2,
  Maximize2,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { copyAndSay } from "@/data/files";
import { MOD } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { useMe, useRow, useRowEvenIfGone, useSlug } from "@/data/selectors";
import type { Task } from "@/types/core";
import type { TaskLayout } from "@/detail/task-body";
import type { QueuePlace } from "@/detail/task-view";
import { restoreTasks, setWatching, trashTasks } from "@/tasks/actions";
import { taskPath } from "@/nav/task-link";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";

interface Props {
  taskKey: string;
  task: Task | undefined;
  layout: TaskLayout;
  onClose: () => void;
  onExpand?: () => void;
  queue?: QueuePlace;
}

export function PanelHeader({ taskKey, task, layout, onClose, onExpand, queue }: Props) {
  const me = useMe();
  const slug = useSlug();
  // An archived project is still where the task lives.
  const project = useRowEvenIfGone("projects", task?.project_id);
  const watching = !!useRow("watchers", task ? `${me.user_id}:${task.id}` : undefined);
  const can = useCan();
  const page = layout === "page";

  return (
    <header
      className={cx(
        "flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 max-md:h-12 max-md:pl-1",
        page ? "md:pl-2" : "md:pl-4",
      )}
    >
      {/* On a phone the task covers the screen: the way out is an arrow. The page has it at every width. */}
      <IconButton label={t("common.back")} size="lg" className="md:hidden" onClick={onClose}>
        <ArrowLeft className="size-5" />
      </IconButton>
      {page && (
        <IconButton label={t("common.back")} hint="Esc" className="mr-1 max-md:hidden" onClick={onClose}>
          <ArrowLeft className="size-4" />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1 text-sm text-ink-2">
        {project && (
          <>
            <Link to={`/${slug}/p/${project.key}/tasks`} className="truncate rounded-xs hover:text-ink">
              {project.name}
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          </>
        )}
        <span className="shrink-0 text-ink tnum">{taskKey}</span>
        {queue && <QueueSteps queue={queue} />}
      </div>
      {task && (
        <>
          {/* Watching is a change too: a read-only member may not make it. */}
          {can.write && (
            <IconButton
              label={watching ? t("detail.unwatch") : t("detail.watch")}
              hint="Shift S"
              aria-pressed={watching}
              className="max-md:size-10"
              onClick={() => setWatching([task], !watching)}
            >
              {watching ? <Eye className="size-4 text-accent-text" /> : <EyeOff className="size-4" />}
            </IconButton>
          )}
          <IconButton
            label={t("detail.copyLink")}
            hint={`Shift ${MOD} ,`}
            className="max-md:size-10"
            onClick={() => void copyAndSay(location.origin + taskPath(slug, taskKey))}
          >
            <Link2 className="size-4" />
          </IconButton>
          {can.editTask(task) && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={t("common.more")} className="max-md:size-10">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  danger
                  icon={<Trash2 />}
                  onSelect={() => {
                    trashTasks([task]);
                    onClose();
                  }}
                >
                  {t("detail.moveToTrash")}
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </>
      )}
      {onExpand && (
        <IconButton label={t("detail.openPage")} hint="Enter" className="max-md:hidden" onClick={onExpand}>
          <Maximize2 className="size-3.5" />
        </IconButton>
      )}
      {!page && (
        <IconButton label={t("common.close")} hint="Esc" className="max-md:hidden" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      )}
    </header>
  );
}

/** "3 of 27" and the way to the task before and after, on a page opened from a list. */
function QueueSteps({ queue }: { queue: QueuePlace }) {
  return (
    <span className="ml-3 flex shrink-0 items-center gap-0.5 border-l border-line pl-2">
      <IconButton
        size="sm"
        label={t("detail.prevTask")}
        hint="K"
        disabled={queue.at === 0}
        onClick={() => queue.step(-1)}
      >
        <ChevronUp className="size-3.5" />
      </IconButton>
      <IconButton
        size="sm"
        label={t("detail.nextTask")}
        hint="J"
        disabled={queue.at >= queue.total - 1}
        onClick={() => queue.step(1)}
      >
        <ChevronDown className="size-3.5" />
      </IconButton>
      <span className="ml-1 text-xs text-ink-3 tnum">
        {t("detail.queue", { at: queue.at + 1, total: queue.total })}
      </span>
    </span>
  );
}

/** Shown under the header while the task is in the trash. */
export function TrashBanner({ task }: { task: Task }) {
  const can = useCan();
  return (
    <output className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-soft px-4 py-2 text-sm text-danger md:px-6">
      <Trash2 className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t("detail.inTrash")}</span>
      {can.edit(task.project_id) && (
        <Button size="sm" onClick={() => restoreTasks([task])}>
          {t("detail.restore")}
        </Button>
      )}
    </output>
  );
}

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
import { cx } from "@/lib/cx";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { send } from "@/lib/mutate";
import { useMe, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Task } from "@/lib/types";
import type { TaskLayout } from "@/detail/task-body";
import type { QueuePlace } from "@/detail/task-view";
import { restoreTasks, trashTasks } from "@/tasks/actions";
import { taskPath } from "@/lib/task-link";
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

function setWatching(task: Task, userId: string, watching: boolean) {
  send({ type: "watch.set", args: { subject: task.id, watching } }, (tx) => {
    if (watching)
      tx.insert("watchers", { user_id: userId, subject_type: "task", subject_id: task.id, created_at: Date.now() });
    else tx.remove("watchers", `${userId}:${task.id}`);
  });
}

export function PanelHeader({ taskKey, task, layout, onClose, onExpand, queue }: Props) {
  const me = useMe();
  const slug = useSlug();
  const project = useStore((s) => (task ? s.c.projects[task.project_id] : undefined));
  const watching = useStore((s) => (task ? !!s.c.watchers[`${me.user_id}:${task.id}`] : false));
  const page = layout === "page";

  async function copyLink() {
    const ok = await copyText(location.origin + taskPath(slug, taskKey));
    if (ok) toast.info(t("common.copied"));
    else toast.error(t("common.copyFailed"));
  }

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
          <IconButton
            label={watching ? t("detail.unwatch") : t("detail.watch")}
            aria-pressed={watching}
            className="max-md:size-10"
            onClick={() => setWatching(task, me.user_id, !watching)}
          >
            {watching ? <Eye className="size-4 text-accent-text" /> : <EyeOff className="size-4" />}
          </IconButton>
          <IconButton label={t("detail.copyLink")} className="max-md:size-10" onClick={copyLink}>
            <Link2 className="size-4" />
          </IconButton>
          {!task.deleted_at && (
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
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-soft px-4 py-2 text-sm text-danger md:px-6"
    >
      <Trash2 className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t("detail.inTrash")}</span>
      <Button size="sm" onClick={() => restoreTasks([task])}>
        {t("detail.restore")}
      </Button>
    </div>
  );
}

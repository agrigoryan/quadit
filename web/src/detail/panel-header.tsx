// The top of the task panel: where the task lives, and what can be done to
// it as a whole (watch, copy its link, move it to the trash, close).

import { ArrowLeft, ChevronRight, Eye, EyeOff, Link2, MoreHorizontal, Trash2, X } from "lucide-react";
import { Link } from "react-router";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { send } from "@/lib/mutate";
import { useMe, useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Task } from "@/lib/types";
import { restoreTasks, trashTasks } from "@/tasks/actions";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";

interface Props {
  taskKey: string;
  task: Task | undefined;
  onClose: () => void;
}

function setWatching(task: Task, userId: string, watching: boolean) {
  send({ type: "watch.set", args: { subject: task.id, watching } }, (tx) => {
    if (watching) tx.insert("watchers", { user_id: userId, subject_type: "task", subject_id: task.id, created_at: Date.now() });
    else tx.remove("watchers", `${userId}:${task.id}`);
  });
}

export function PanelHeader({ taskKey, task, onClose }: Props) {
  const me = useMe();
  const slug = useSlug();
  const project = useStore((s) => (task ? s.c.projects[task.project_id] : undefined));
  const watching = useStore((s) => (task ? !!s.c.watchers[`${me.user_id}:${task.id}`] : false));

  async function copyLink() {
    const ok = await copyText(`${location.origin}/${slug}/task/${taskKey}`);
    if (ok) toast.info(t("common.copied"));
    else toast.error(t("common.copyFailed"));
  }

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4 max-md:h-12 max-md:pl-1">
      <IconButton label={t("common.back")} size="lg" className="md:hidden" onClick={onClose}>
        <ArrowLeft className="size-5" />
      </IconButton>
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
      <IconButton label={t("common.close")} hint="Esc" className="max-md:hidden" onClick={onClose}>
        <X className="size-4" />
      </IconButton>
    </header>
  );
}

/** Shown under the header while the task is in the trash. */
export function TrashBanner({ task }: { task: Task }) {
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-soft px-4 py-2 text-sm text-danger md:px-6">
      <Trash2 className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t("detail.inTrash")}</span>
      <Button size="sm" onClick={() => restoreTasks([task])}>
        {t("detail.restore")}
      </Button>
    </div>
  );
}

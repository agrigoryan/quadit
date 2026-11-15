// One task, whole: its header, then its body or the reason there is none
// (still looking, no access, nothing at this address). The panel and the
// task's own page are both a frame around this.

import { useHotkeys } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useTaskByKey } from "@/lib/selectors";
import { useTaskDetail } from "@/lib/task-detail";
import { usePageTitle } from "@/lib/ui-state";
import { useFindTask } from "@/detail/data";
import { useFileDrop } from "@/detail/file-drop";
import { PanelHeader, TrashBanner } from "@/detail/panel-header";
import { useRevealFromHash } from "@/detail/reveal-hash";
import { TaskBody, type TaskLayout } from "@/detail/task-body";
import { LostProject, useLostProject } from "@/shell/placeholders";
import { isTaskPath } from "@/tasks/task-link";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

interface Props {
  taskKey: string;
  layout: TaskLayout;
  /** Leaves the task: closes the panel, or goes back from the page. Escape does the same. */
  onClose: () => void;
  /** In the panel: turns it into the task's own page. Enter does the same. */
  onExpand?: () => void;
}

/**
 * A focused button, link or field answers Enter itself. The link of the row
 * that was clicked to open the panel does not count: Enter after a click
 * goes on to the page.
 */
function onControl(e: KeyboardEvent): boolean {
  const control = e.target instanceof HTMLElement ? e.target.closest("a, button, input, textarea, select, [role=button]") : null;
  return control !== null && !(control instanceof HTMLAnchorElement && isTaskPath(control.pathname) && !control.closest("[data-task-panel]"));
}

/** Names the browser tab after the task, for its own page: the panel leaves the name of the page under it. */
function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

export function TaskView({ taskKey, layout, onClose, onExpand }: Props) {
  const task = useTaskByKey(taskKey);
  const looking = useFindTask(taskKey, !!task);
  const lost = useLostProject(taskKey.split("-")[0]);
  const status = useTaskDetail(task?.id);
  useRevealFromHash(!!task);
  const drop = useFileDrop(task);
  useHotkeys(
    {
      Escape: onClose,
      Enter: (e) => {
        if (!onExpand || onControl(e)) return;
        e.preventDefault();
        onExpand();
      },
    },
    { layer: "panel" },
  );

  return (
    <div {...drop.handlers} className="relative flex min-h-0 flex-1 flex-col">
      {layout === "page" && <PageTitle title={task ? `${task.key} ${task.title}` : taskKey} />}
      <PanelHeader taskKey={taskKey} task={task} layout={layout} onClose={onClose} onExpand={onExpand} />
      {!task ? (
        looking ? (
          <Loading />
        ) : lost ? (
          <LostProject />
        ) : (
          <EmptyState title={t("common.notFound")} hint={t("common.notFoundHint")} />
        )
      ) : (
        <>
          {!!task.deleted_at && <TrashBanner task={task} />}
          <TaskBody task={task} status={status} layout={layout} />
        </>
      )}
      {drop.note}
    </div>
  );
}

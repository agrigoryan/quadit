// One task, whole: its header, then its body or the reason there is none
// (still looking, the server did not answer, no access, nothing at this
// address). The panel and the task's own page are both a frame around this.

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { overlayOpen, useHotkeys } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { useRowEvenIfGone, useSlug } from "@/data/selectors";
import { useFindTask } from "@/data/find-task";
import { useTaskDetail } from "@/data/task-detail";
import { usePageTitle } from "@/lib/ui-state";
import type { Task } from "@/types/core";
import { startComment } from "@/detail/comment-box";
import { useFileDrop } from "@/detail/file-drop";
import { PanelHeader, TrashBanner } from "@/detail/panel-header";
import { useRevealFromHash } from "@/detail/reveal-hash";
import { TaskBody, type TaskLayout } from "@/detail/task-body";
import { LostProject, useLostProject } from "@/ui/not-found";
import { isTaskPath, taskPath } from "@/nav/task-link";
import { useTaskKeys } from "@/tasks/task-keys";
import { EmptyState } from "@/ui/empty";
import { LoadFailed } from "@/ui/load-gate";
import { Loading } from "@/ui/spinner";

/** Where a task's page stands in the list it was opened from. */
export interface QueuePlace {
  /** Counted from 0. */
  at: number;
  total: number;
  /** Goes to the task `by` places on (1) or back (-1); nothing at either end. */
  step: (by: number) => void;
}

interface Props {
  taskKey: string;
  layout: TaskLayout;
  /** Leaves the task: closes the panel, or goes back from the page. Escape does the same. */
  onClose: () => void;
  /** In the panel: turns it into the task's own page. Enter does the same. */
  onExpand?: () => void;
  /** On the page, when it was opened from a list: J and K (and the arrows) step along that list. */
  queue?: QueuePlace;
}

/**
 * A focused button, link or field answers Enter itself. The link of the row
 * that was clicked to open the panel does not count: Enter after a click
 * goes on to the page.
 */
function onControl(e: KeyboardEvent): boolean {
  const control =
    e.target instanceof HTMLElement ? e.target.closest("a, button, input, textarea, select, [role=button]") : null;
  return (
    control !== null &&
    !(control instanceof HTMLAnchorElement && isTaskPath(control.pathname) && !control.closest("[data-task-panel]"))
  );
}

/** Names the browser tab after the task, for its own page: the panel leaves the name of the page under it. */
function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

/**
 * A task moved to another project takes that project's key: the panel or
 * page showing it follows it to its new address, as it was opened (over the
 * same list, with the same place in it), instead of finding nothing at the
 * old one. A link kept from before the move goes the same way.
 */
function useFollowNewKey(taskKey: string, task: Task | undefined) {
  const slug = useSlug();
  const location = useLocation();
  const navigate = useNavigate();
  // The task last shown here, by id: what stays when its key changes.
  const [shownId, setShownId] = useState(task?.id);
  if (task && task.id !== shownId) setShownId(task.id);
  const shown = useRowEvenIfGone("tasks", task?.id ?? shownId);
  const movedTo = shown && shown.key !== taskKey ? shown.key : undefined;
  useEffect(() => {
    if (movedTo) void navigate(taskPath(slug, movedTo) + location.hash, { replace: true, state: location.state });
  }, [movedTo, slug, location.hash, location.state, navigate]);
}

export function TaskView({ taskKey, layout, onClose, onExpand, queue }: Props) {
  // The task's own page shows it in the trash or the archive too.
  const find = useFindTask(taskKey);
  const { task } = find;
  useFollowNewKey(taskKey, task);
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
      // Ctrl+M on every system: the command key with M is the Mac's own (it puts the window away).
      "mod+m": (e) => {
        if (!e.ctrlKey || e.metaKey || overlayOpen()) return;
        if (startComment()) e.preventDefault();
      },
    },
    { layer: "panel" },
  );
  // I, the copy keys and Cmd+Backspace act on the open task; S/A/P/L are its property rows' own (detail/properties.tsx).
  useTaskKeys({ tasksFor: () => (task ? [task] : []), layer: "panel", onTrashed: onClose });
  const step = (by: number) => (e: KeyboardEvent) => {
    e.preventDefault();
    queue?.step(by);
  };
  useHotkeys({ j: step(1), k: step(-1), ArrowDown: step(1), ArrowUp: step(-1) }, { layer: "panel", enabled: !!queue });

  return (
    <div {...drop.handlers} className="relative flex min-h-0 flex-1 flex-col">
      {layout === "page" && <PageTitle title={task ? `${task.key} ${task.title}` : taskKey} />}
      <PanelHeader taskKey={taskKey} task={task} layout={layout} onClose={onClose} onExpand={onExpand} queue={queue} />
      {!task ? (
        find.looking ? (
          <Loading />
        ) : find.error ? (
          <LoadFailed error={find.error} onRetry={find.retry} />
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

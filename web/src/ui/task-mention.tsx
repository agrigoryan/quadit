// A task named in text, wherever text names one: a key in Markdown
// (ui/markdown.tsx) and a task chip in a page (docs/editor/chips.tsx). It
// shows the task as it stands now in the workspace copy (its status, key
// and title) or that it is gone, and opens it. Its card (ui/mention-card.tsx)
// says who has the task, its status and its priority.

import type { ComponentProps, HTMLAttributes } from "react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useFindTask } from "@/data/find-task";
import { useMember, useRowEvenIfGone } from "@/data/selectors";
import { useRestLoaded } from "@/data/store";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import { MentionCard } from "@/ui/mention-card";

interface Props {
  taskKey: string;
  /**
   * For a chip in a page's editor, where an <a> would be edited as part of
   * the text and no router may be around: the props of the <span> that acts
   * as the link. Left out, the mention is a link to the task
   * (nav/task-link.ts).
   */
  control?: HTMLAttributes<HTMLSpanElement>;
}

export function TaskMention({ taskKey: written, control }: Props) {
  // Until the finished work has come, a task that is not here may be a closed one on its way: asked of the server after.
  const restLoaded = useRestLoaded();
  // A trashed task is found, to be shown as gone; a moved one, to be shown under its new key.
  const { task, looking } = useFindTask(written, restLoaded);
  const taskKey = task?.key ?? written;
  const status = useRowEvenIfGone("statuses", task?.status_id);
  const gone = task ? !!task.deleted_at : restLoaded && !looking;
  const className = cx("task-mention", gone && "is-gone");
  // The spaces read the mention aloud, and copy it, as "SVA-12 Paint the fence"; the layout leaves them out.
  const look = (
    <>
      {status && !gone && <StatusIcon category={status.category} title={status.name} className="task-mention-icon" />}
      {status && !gone && " "}
      <span className="task-mention-key">{taskKey.toUpperCase()}</span>
      {task && (
        <>
          {" "}
          <span className="task-mention-title">{task.title}</span>
        </>
      )}
    </>
  );

  return (
    <MentionCard
      mention={
        control ? (
          <span {...control} className={className}>
            {look}
          </span>
        ) : (
          <TaskLink taskKey={taskKey} className={className}>
            {look}
          </TaskLink>
        )
      }
    >
      <TaskCard taskKey={taskKey} />
    </MentionCard>
  );
}

/** The mention as a link to the task, opened the way every link to a task opens. The card's trigger gives it more props. */
function TaskLink({ taskKey, ...rest }: { taskKey: string } & Omit<ComponentProps<typeof Link>, "to">) {
  return <Link {...useTaskLink({ key: taskKey })} {...rest} />;
}

/** What the card says about the task. One the copy does not hold is asked of the server first. */
function TaskCard({ taskKey }: { taskKey: string }) {
  const find = useFindTask(taskKey);
  const { task } = find;
  const status = useRowEvenIfGone("statuses", task?.status_id);
  const assignee = useMember(task?.assignee_id);
  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <span className="font-semibold text-ink-3 tabular-nums">{taskKey.toUpperCase()}</span>
        {task && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-ink-2">
            <Avatar member={assignee} size="xs" />
            <span className="truncate">{assignee?.name ?? t("taskCard.noAssignee")}</span>
          </span>
        )}
      </div>
      {task ? (
        <>
          <p className="mt-1.5 line-clamp-3 text-sm leading-snug font-medium">{task.title}</p>
          {task.deleted_at || task.archived_at ? (
            <p className="mt-2">
              <Badge tone="wait">{t(task.deleted_at ? "taskCard.inTrash" : "taskCard.archived")}</Badge>
            </p>
          ) : (
            <div className="mt-2 flex items-center gap-3 text-xs text-ink-2">
              {status && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <StatusIcon category={status.category} />
                  <span className="truncate">{status.name}</span>
                </span>
              )}
              {task.priority > 0 && (
                <span className="flex items-center gap-1.5">
                  <PriorityIcon priority={task.priority} title="" />
                  {tMaybe(`priority.${task.priority}`)}
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-sm text-ink-3">
          {find.looking ? t("common.loading") : find.error || t("taskCard.notThere")}
        </p>
      )}
    </>
  );
}

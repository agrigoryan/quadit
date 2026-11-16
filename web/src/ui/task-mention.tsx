// A task named in text, wherever text names one: a key in Markdown
// (ui/markdown.tsx) and a task chip in a page (docs/editor/chips.tsx). It
// shows the task as it stands now in the workspace copy (its status, key
// and title) or that it is gone, and opens it. A pointer that rests on it,
// or the keyboard reaching it, shows a small card about the task: who has
// it, its status and its priority.

import { HoverCard } from "radix-ui";
import { type ComponentProps, type HTMLAttributes, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useFindTask } from "@/data/find-task";
import { useMember, useRowEvenIfGone, useTaskByKeyEvenIfGone } from "@/data/selectors";
import { useRestLoaded } from "@/data/store";
import { useTaskLink } from "@/nav/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { PriorityIcon, StatusIcon } from "@/ui/icons";

/** How long the pointer rests on a mention before its card shows, and lingers after it leaves. */
const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;

/**
 * True when a key was pressed since the pointer last moved. Text typed
 * around a mention moves it under a mouse that rests, and the browser takes
 * that for the pointer coming over it: no card opens for that. Written by
 * the two listeners below, which last as long as the page.
 */
let keysSinceMove = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keysSinceMove = true), true);
  document.addEventListener("pointermove", () => (keysSinceMove = false), true);
}

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

export function TaskMention({ taskKey, control }: Props) {
  // A trashed task is found, to be shown as gone.
  const task = useTaskByKeyEvenIfGone(taskKey);
  const status = useRowEvenIfGone("statuses", task?.status_id);
  // Until the finished work has come, a task that is not here may be a closed one on its way.
  const restLoaded = useRestLoaded();
  const gone = task ? !!task.deleted_at : restLoaded;
  const [open, setOpen] = useState(false);
  const cardId = useId();
  // Whether the mention has the keyboard's focus, which opens the card whatever was typed before.
  const keyboardFocus = useRef(false);
  // Whether the card was kept shut for keys pressed, so the pointer's next move over the mention opens it.
  const heldBack = useRef(false);

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
    <HoverCard.Root
      open={open}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
      onOpenChange={(next) => {
        if (next && keysSinceMove && !keyboardFocus.current) {
          heldBack.current = true;
          return;
        }
        setOpen(next);
      }}
    >
      <HoverCard.Trigger
        asChild
        aria-describedby={open ? cardId : undefined}
        // A tap or a click focuses a link too; only the keyboard's focus is a reason to show the card.
        onFocus={(e) => {
          keyboardFocus.current = e.currentTarget.matches(":focus-visible");
          if (!keyboardFocus.current) e.preventDefault();
        }}
        onBlur={() => (keyboardFocus.current = false)}
        onPointerMove={() => {
          if (!heldBack.current) return;
          heldBack.current = false;
          setOpen(true);
        }}
        onPointerLeave={() => (heldBack.current = false)}
        onClick={() => setOpen(false)}
      >
        {control ? (
          <span {...control} className={className}>
            {look}
          </span>
        ) : (
          <TaskLink taskKey={taskKey} className={className}>
            {look}
          </TaskLink>
        )}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          id={cardId}
          role="tooltip"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-surface p-3 text-ink shadow-pop outline-none animate-pop"
        >
          <TaskCard taskKey={taskKey} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/** The mention as a link to the task, opened the way every link to a task opens. The card's trigger gives it more props. */
function TaskLink({ taskKey, ...rest }: { taskKey: string } & Omit<ComponentProps<typeof Link>, "to">) {
  return <Link {...useTaskLink({ key: taskKey })} {...rest} />;
}

/** What the card says about the task. One the copy does not hold is asked of the server first. */
function TaskCard({ taskKey }: { taskKey: string }) {
  const task = useTaskByKeyEvenIfGone(taskKey);
  const find = useFindTask(taskKey, !!task);
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

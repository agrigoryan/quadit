import { CalendarDays, Globe, Hourglass, Layers } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useMember, useSubtaskProgress } from "@/lib/selectors";
import { dueLabel } from "@/lib/time";
import type { Task } from "@/types/core";
import { waitsOutside } from "@/tasks/actions";
import { Avatar } from "@/ui/avatar";
import { Tooltip } from "@/ui/tooltip";

/**
 * "Waits on @x": who has to act next. When that is you it wears the
 * highlighter, the one loud colour in the app.
 */
export function WaitsOnChip({ task, className }: { task: Task; className?: string }) {
  const me = useMe();
  const member = useMember(task.waiting_on_id);
  if (waitsOutside(task)) {
    // Nobody here can move it: it waits on something outside, and the note says what.
    const text = task.waiting_on_note
      ? t("task.waitsOutsideNote", { note: task.waiting_on_note })
      : t("task.waitsOutside");
    return (
      <span
        title={text}
        className={cx(
          "inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-sm bg-wait-soft pr-1.5 pl-1 text-xs font-medium whitespace-nowrap text-wait",
          className,
        )}
      >
        <Globe className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  if (!task.waiting_on_id || !member) return null;
  const mine = member.user_id === me.user_id;
  const chip = (
    <span
      className={cx(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-sm pr-1.5 pl-1 text-xs font-medium whitespace-nowrap",
        mine ? "bg-move text-move-ink" : "bg-wait-soft text-wait",
        className,
      )}
    >
      <Hourglass className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{mine ? t("task.waitsOnYou") : t("task.waitsOn", { name: `@${member.handle}` })}</span>
    </span>
  );
  if (!task.waiting_on_note) return chip;
  return (
    <Tooltip label={task.waiting_on_note} side="top">
      {chip}
    </Tooltip>
  );
}

export function DueChip({ day, done, className }: { day: string; done?: boolean; className?: string }) {
  const due = dueLabel(day);
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 text-xs tnum whitespace-nowrap",
        done || due.tone === "later" ? "text-ink-3" : due.tone === "late" ? "font-medium text-danger" : "text-wait",
        className,
      )}
    >
      <CalendarDays className="size-3" aria-hidden />
      {due.text}
    </span>
  );
}

export function EpicChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 max-w-36 shrink-0 items-center gap-1 text-xs text-ink-2 whitespace-nowrap",
        className,
      )}
    >
      <Layers className="size-3 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The assignee's avatar, or a dashed circle for nobody. */
export function AssigneeAvatar({ userId, size = "sm" }: { userId: string | undefined; size?: "xs" | "sm" | "md" }) {
  const member = useMember(userId);
  return <Avatar member={member} size={size} />;
}

/**
 * How far a task's sub-tasks have got: a ring that fills with the share
 * done, then "done/total". Nothing for a task without sub-tasks.
 */
export function SubtaskPill({ taskId, className }: { taskId: string; className?: string }) {
  const progress = useSubtaskProgress(taskId);
  if (!progress) return null;
  const { done, total } = progress;
  const label = t("task.subtasks", { done, total });
  // A circle of radius 5 is 31.4 long around: the dash is the done share of it.
  const around = 2 * Math.PI * 5;
  return (
    <span
      title={label}
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-xs text-ink-2 tnum whitespace-nowrap",
        className,
      )}
    >
      <svg viewBox="0 0 14 14" className="size-3 shrink-0 -rotate-90" aria-hidden>
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        {done > 0 && (
          <circle
            cx="7"
            cy="7"
            r="5"
            fill="none"
            stroke="var(--cat-done)"
            strokeWidth="2"
            strokeDasharray={`${(done / total) * around} ${around}`}
          />
        )}
      </svg>
      <span aria-hidden>
        {done}/{total}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

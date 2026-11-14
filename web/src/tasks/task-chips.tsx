import { CalendarDays, Hourglass, Layers } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import { dueLabel } from "@/lib/time";
import type { Task } from "@/lib/types";
import { Avatar } from "@/ui/avatar";
import { Tooltip } from "@/ui/tooltip";

/**
 * "Waits on @x": who has to act next. When that is you it wears the
 * highlighter, the one loud colour in the app.
 */
export function WaitsOnChip({ task, className }: { task: Task; className?: string }) {
  const me = useMe();
  const member = useMember(task.waiting_on_id);
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
    <span className={cx("inline-flex h-5 max-w-36 shrink-0 items-center gap-1 text-xs text-ink-2 whitespace-nowrap", className)}>
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

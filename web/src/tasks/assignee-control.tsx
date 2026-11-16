import { t } from "@/lib/i18n";
import { useMember } from "@/data/selectors";
import type { Task } from "@/types/core";
import { MemberCard } from "@/tasks/member-card";
import { assignee as assigneeProperty } from "@/tasks/properties/assignee";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";

/**
 * A task's assignee as their avatar, a button: it changes the assignee where
 * the viewer may (`readOnly` false), and otherwise opens the card about the
 * assignee. Read-only and unassigned, it is a disabled picker.
 */
export function AssigneeControl({
  task,
  readOnly,
  className,
}: {
  task: Task;
  readOnly: boolean;
  /** The button's look: a square a little bigger than the avatar, above a link stretched over its row or card. */
  className: string;
}) {
  const assignee = useMember(task.assignee_id);
  if (readOnly && assignee) {
    // Who cannot change the assignee learns about them instead.
    return (
      <MemberCard member={assignee}>
        <button type="button" className={className}>
          <Avatar member={assignee} size="sm" />
        </button>
      </MemberCard>
    );
  }
  return (
    <TaskPropertyPicker property={assigneeProperty} tasks={[task]} align="end">
      <button
        type="button"
        className={className}
        disabled={readOnly}
        aria-label={`${t("prop.assignee")}: ${assignee ? assignee.name : t("task.unassigned")}`}
      >
        <Avatar member={assignee} size="sm" />
      </button>
    </TaskPropertyPicker>
  );
}

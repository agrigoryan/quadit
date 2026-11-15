import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useDecisionFlag, useSubtaskProgress } from "@/lib/selectors";
import { useIsDraft, useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { waitsOutside } from "@/tasks/actions";
import { AssigneeAvatar, DueChip, WaitsOnChip } from "@/tasks/task-chips";
import { useTaskLink } from "@/tasks/task-row";
import { LabelChip } from "@/ui/badge";
import { DecisionMark, PriorityIcon } from "@/ui/icons";

/** What a card shows; shared by the card in its column and the copy that follows the pointer. */
export const CardBody = memo(function CardBody({ task }: { task: Task }) {
  const labels = useStore((s) => s.c.labels);
  const decision = useDecisionFlag(task.id);
  const progress = useSubtaskProgress(task.id);
  const tags = (task.label_ids ?? []).map((id) => labels[id]).filter((l) => l !== undefined);
  return (
    <>
      <div className="flex items-center gap-1.5">
        <PriorityIcon priority={task.priority} />
        <span className="flex-1 text-xs text-ink-3 tnum">{task.key}</span>
        {decision && <DecisionMark mine={decision === "mine"} title={decision === "mine" ? t("task.decisionYours") : t("task.decisionOpen")} />}
        <AssigneeAvatar userId={task.assignee_id} />
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm leading-[1.35]">{task.title}</p>
      {(task.waiting_on_id || waitsOutside(task) || tags.length > 0 || task.due_on || progress) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <WaitsOnChip task={task} />
          {tags.slice(0, 3).map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} />
          ))}
          {task.due_on && <DueChip day={task.due_on} />}
          {progress && <span className="text-xs text-ink-3 tnum">{progress}</span>}
        </div>
      )}
    </>
  );
});

const shell = "block rounded-md border border-line bg-surface p-2.5 shadow-card";

/** A task on the board. Drag it to reorder or to move it to another column; click to open. */
export const BoardCard = memo(function BoardCard({ id, task }: { id: string; task: Task }) {
  const draft = useIsDraft(task.id);
  // A card just made waits for its number: it cannot be opened or moved until the server has it.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: draft });
  const link = useTaskLink(task);
  const style = { transform: CSS.Translate.toString(transform), transition };
  if (draft) {
    return (
      <div ref={setNodeRef} style={style} data-task={task.id} aria-busy className={cx(shell, "text-ink-2")}>
        <CardBody task={task} />
      </div>
    );
  }
  return (
    <Link
      {...link}
      ref={setNodeRef}
      style={style}
      draggable={false}
      data-task={task.id}
      className={cx(shell, "touch-manipulation outline-offset-2 hover:border-line-strong", isDragging && "opacity-35")}
      {...attributes}
      {...listeners}
      role="link"
    >
      <CardBody task={task} />
    </Link>
  );
});

/** The copy of a card that follows the pointer while dragging. */
export function CardOverlay({ task }: { task: Task }) {
  return (
    <div className={cx(shell, "rotate-[1.5deg] cursor-grabbing shadow-pop")}>
      <CardBody task={task} />
    </div>
  );
}

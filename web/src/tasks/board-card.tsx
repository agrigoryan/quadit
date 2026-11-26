import { memo, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useDecisionFlag, useLookup, useRowEvenIfGone, useSubtaskProgress } from "@/data/selectors";
import { useIsDraft } from "@/data/store";
import type { Task } from "@/types/core";
import { waitsOutside } from "@/tasks/actions";
import { AssigneeControl } from "@/tasks/assignee-control";
import { scaleOf } from "@/tasks/estimates";
import { AssigneeAvatar, DueChip, EstimateChip, SubtaskPill, WaitsOnChip } from "@/tasks/task-chips";
import { useTaskLink } from "@/nav/task-link";
import { LabelChip } from "@/ui/badge";
import { DecisionMark, PriorityIcon } from "@/ui/icons";

/**
 * What a card shows; shared by the card in its column and the copy that follows the pointer.
 * The card in its column puts its controls in: `title` the link that opens the task, `avatar`
 * the assignee's button. Without them the title and avatar are only shown.
 */
const CardBody = memo(function CardBody({
  task,
  title,
  avatar,
}: {
  task: Task;
  title?: ReactNode;
  avatar?: ReactNode;
}) {
  const labels = useLookup("labels");
  const decision = useDecisionFlag(task.id);
  const progress = useSubtaskProgress(task.id);
  const tags = (task.label_ids ?? []).map((id) => labels[id]).filter((l) => l !== undefined);
  const scale = scaleOf(useRowEvenIfGone("projects", task.project_id));
  const estimate = scale && task.estimate != null ? task.estimate : undefined;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <PriorityIcon priority={task.priority} />
        <span className="flex-1 text-xs text-ink-3 tnum">{task.key}</span>
        {decision && (
          <DecisionMark
            mine={decision === "mine"}
            title={decision === "mine" ? t("task.decisionYours") : t("task.decisionOpen")}
          />
        )}
        {avatar ?? <AssigneeAvatar userId={task.assignee_id} />}
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm leading-[1.35]">{title ?? task.title}</p>
      {(task.waiting_on_id ||
        waitsOutside(task) ||
        tags.length > 0 ||
        task.due_on ||
        estimate !== undefined ||
        progress) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <WaitsOnChip task={task} />
          {tags.slice(0, 3).map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} />
          ))}
          {task.due_on && <DueChip day={task.due_on} />}
          {scale && estimate !== undefined && <EstimateChip value={estimate} scale={scale} />}
          <SubtaskPill taskId={task.id} />
        </div>
      )}
    </>
  );
});

const shell = "block rounded-md border border-line bg-surface p-2.5 shadow-card";

/**
 * A task on the board. Drag it from anywhere to reorder it or to move it to another column;
 * click anywhere to open it. The card is built as a list's row is (tasks/task-row.tsx): its
 * title is the link, stretched over the card, and the assignee's avatar a button above it.
 * The link is what has the focus: keys on it are the board's (it carries data-task, as the card
 * does), and Shift+Space on it lifts the card.
 */
export const BoardCard = memo(function BoardCard({ id, task }: { id: string; task: Task }) {
  const draft = useIsDraft(task.id);
  // A card just made waits for its number: it cannot be opened or moved until the server has it.
  // Nor is it moved by someone who may not change the task (read-only, another project).
  const fixed = !useCan().editTask(task);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: draft || fixed,
    // The link that can also be lifted: dnd-kit would call it a button.
    attributes: { role: "link" },
  });
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
    <article
      ref={setNodeRef}
      style={style}
      data-task={task.id}
      className={cx(shell, "relative touch-manipulation hover:border-line-strong", isDragging && "opacity-35")}
      {...listeners}
    >
      <CardBody
        task={task}
        title={
          <Link
            {...link}
            ref={setActivatorNodeRef}
            draggable={false}
            data-task={task.id}
            aria-label={`${task.key} ${task.title}`}
            className="outline-none after:absolute after:-inset-px after:rounded-md after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
            {...attributes}
          >
            {task.title}
          </Link>
        }
        avatar={<AssigneeControl task={task} readOnly={fixed} className={avatarButton} />}
      />
    </article>
  );
});

/** The avatar's button: a little bigger than the avatar, as much over its edges as it is wider, so the card keeps its size. */
const avatarButton =
  "relative z-[1] -m-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover data-[state=open]:bg-hover";

/** The copy of a card that follows the pointer while dragging. */
export function CardOverlay({ task }: { task: Task }) {
  return (
    <div className={cx(shell, "rotate-[1.5deg] cursor-grabbing shadow-pop")}>
      <CardBody task={task} />
    </div>
  );
}

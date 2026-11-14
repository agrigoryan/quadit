import { CircleDot, Tag, Trash2, UserRound, X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Task } from "@/lib/types";
import { trashTasks } from "@/tasks/actions";
import { type TaskProperty, TaskPropertyPicker } from "@/tasks/property-picker";
import { Button, IconButton } from "@/ui/button";
import { PriorityIcon } from "@/ui/icons";

interface Props {
  tasks: Task[];
  onClear: () => void;
}

const actions: { kind: TaskProperty; label: () => string; icon: React.ReactNode }[] = [
  { kind: "status", label: () => t("prop.status"), icon: <CircleDot className="size-3.5" aria-hidden /> },
  { kind: "assignee", label: () => t("prop.assignee"), icon: <UserRound className="size-3.5" aria-hidden /> },
  { kind: "priority", label: () => t("prop.priority"), icon: <PriorityIcon priority={2} title="" /> },
  { kind: "labels", label: () => t("prop.labels"), icon: <Tag className="size-3.5" aria-hidden /> },
];

/** Floats above the list while tasks are selected: change them all at once, as one batch. */
export function BulkBar({ tasks, onClear }: Props) {
  if (tasks.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.selected", { n: tasks.length })}
      className="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 overflow-x-auto rounded-lg bg-surface p-1.5 pl-3 shadow-pop no-scrollbar animate-pop"
    >
      <span className="mr-1 shrink-0 text-sm font-medium tnum">{t("bulk.selected", { n: tasks.length })}</span>
      {actions.map((a) => (
        <TaskPropertyPicker key={a.kind} kind={a.kind} tasks={tasks} side="top">
          <Button size="md" className="max-sm:px-2">
            {a.icon}
            <span className="max-sm:hidden">{a.label()}</span>
          </Button>
        </TaskPropertyPicker>
      ))}
      <Button
        variant="danger-quiet"
        className="max-sm:px-2"
        onClick={() => {
          trashTasks(tasks);
          onClear();
        }}
      >
        <Trash2 className="size-3.5" aria-hidden />
        <span className="max-sm:hidden">{t("bulk.delete")}</span>
      </Button>
      <IconButton label={t("bulk.clear")} hint="Esc" onClick={onClear}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

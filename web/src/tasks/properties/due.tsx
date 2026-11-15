// The day a task is due, if any.

import { X } from "lucide-react";
import { useCan } from "@/lib/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Task } from "@/lib/types";
import { setDue } from "@/tasks/actions";
import { inlineField, PropRow } from "@/tasks/properties/panel-row";
import type { PanelProps, TaskProperty } from "@/tasks/properties/property";
import { Tooltip } from "@/ui/tooltip";

/** The browser's own date field, dressed to sit in the grid, with a way to clear it. */
function DueField({ task }: { task: Task }) {
  const can = useCan();
  const readOnly = !can.editTask(task);
  return (
    <>
      <input
        type="date"
        aria-label={t("prop.due")}
        readOnly={readOnly}
        value={task.due_on ?? ""}
        onChange={(e) => setDue([task], e.target.value || null)}
        className={cx(inlineField, "tnum", !task.due_on && "text-ink-3 focus:text-ink")}
      />
      {task.due_on && !readOnly && (
        <Tooltip label={t("prop.clearDue")}>
          <button
            type="button"
            aria-label={t("prop.clearDue")}
            onClick={() => setDue([task], null)}
            className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-9"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      )}
    </>
  );
}

function DueRow({ task }: PanelProps) {
  return (
    <PropRow label={t("prop.due")}>
      <DueField task={task} />
    </PropRow>
  );
}

export const due = {
  name: "due",
  title: () => t("prop.due"),
  Panel: DueRow,
} satisfies TaskProperty<"due">;

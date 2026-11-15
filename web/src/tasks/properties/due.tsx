// The day a task is due, if any.

import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useCan } from "@/lib/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Task } from "@/lib/types";
import { setDue } from "@/tasks/actions";
import { inlineField, PropRow } from "@/tasks/properties/panel-row";
import { type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
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

/** One due date for a whole selection, or none. */
function DueForm({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  const [day, setDay] = useState(() => shared(tasks, (task) => task.due_on) ?? "");
  const set = (value: string | null) => {
    setDue(tasks, value);
    onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (day) set(day);
      }}
    >
      <label htmlFor="bulk-due" className="text-xs font-medium text-ink-2">
        {t("bulk.due.label", { n: tasks.length })}
      </label>
      <Input id="bulk-due" type="date" autoFocus value={day} onChange={(e) => setDay(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => set(null)}>
          {t("prop.clearDue")}
        </Button>
        <Button type="submit" variant="primary" disabled={!day}>
          {t("bulk.set")}
        </Button>
      </div>
    </form>
  );
}

export const due = {
  name: "due",
  title: () => t("prop.due"),
  Panel: DueRow,
  bulk: { place: "menu", icon: <CalendarDays />, label: () => t("bulk.due"), Form: DueForm },
} satisfies TaskProperty<"due">;

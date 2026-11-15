// How much work a task is, in points, where its project counts them.

import { useState } from "react";
import { Gauge } from "lucide-react";
import { useCan } from "@/lib/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useRowEvenIfGone } from "@/lib/selectors";
import type { Task } from "@/lib/types";
import { setEstimate } from "@/tasks/actions";
import { inlineField, PropRow } from "@/tasks/properties/panel-row";
import { type PanelProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** Typed in place; saved on Enter or on leaving the box. Nothing, zero or less is no estimate. */
function EstimateField({ task }: { task: Task }) {
  const [draft, setDraft] = useState<string | null>(null);
  const can = useCan();

  function save() {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    const next = draft.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    if (next !== (task.estimate ?? null)) setEstimate([task], next);
    setDraft(null);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={t("prop.estimate")}
      placeholder={t("detail.estimatePlaceholder")}
      readOnly={!can.editTask(task)}
      value={draft ?? (task.estimate ? String(task.estimate) : "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(inlineField, "w-20 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
    />
  );
}

/** Shown where the task's project counts estimates. */
function EstimateRow({ task }: PanelProps) {
  const project = useRowEvenIfGone("projects", task.project_id);
  if (!project?.settings?.estimates) return null;
  return (
    <PropRow label={t("prop.estimate")}>
      <EstimateField task={task} />
    </PropRow>
  );
}

/** One estimate, in points, for a whole selection, or none. */
function EstimateForm({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  const [points, setPoints] = useState(() => String(shared(tasks, (task) => task.estimate) ?? ""));
  const n = Number(points);
  const valid = points.trim() !== "" && Number.isInteger(n) && n > 0;
  const set = (value: number | null) => {
    setEstimate(tasks, value);
    onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) set(n);
      }}
    >
      <label htmlFor="bulk-estimate" className="text-xs font-medium text-ink-2">
        {t("bulk.estimate.label", { n: tasks.length })}
      </label>
      <Input
        id="bulk-estimate"
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        autoFocus
        value={points}
        onChange={(e) => setPoints(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => set(null)}>
          {t("bulk.estimate.clear")}
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          {t("bulk.set")}
        </Button>
      </div>
    </form>
  );
}

export const estimate = {
  name: "estimate",
  title: () => t("prop.estimate"),
  Panel: EstimateRow,
  bulk: {
    place: "menu",
    icon: <Gauge />,
    label: () => t("bulk.estimate"),
    // Unlike the panel's row, which wants estimates turned on, the bar offers them unless they are turned off.
    offered: (project) => project?.settings?.estimates !== false,
    Form: EstimateForm,
  },
} satisfies TaskProperty<"estimate">;

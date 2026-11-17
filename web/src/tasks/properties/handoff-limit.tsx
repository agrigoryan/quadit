// How many times a task may pass from agent to agent in all; past it, a
// person has to take it. Admins set it; nothing set is no limit.

import { useState } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Task } from "@/types/core";
import { setHandoffLimit } from "@/tasks/actions";
import { inlineField, PropRow } from "@/tasks/properties/panel-row";
import type { PanelProps, TaskProperty } from "@/tasks/properties/property";

/** Typed in place; saved on Enter or on leaving the box. Nothing, zero or less is no limit. */
function HandoffLimitField({ task }: { task: Task }) {
  const [draft, setDraft] = useState<string | null>(null);
  const can = useCan();

  function save() {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    const next = draft.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    if (next !== (task.handoff_limit ?? null)) setHandoffLimit([task], next);
    setDraft(null);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={t("prop.handoffLimit")}
      placeholder={t("prop.handoffLimit.none")}
      readOnly={!can.editTask(task)}
      value={draft ?? (task.handoff_limit ? String(task.handoff_limit) : "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(inlineField, "w-24 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
    />
  );
}

/** Admins set a task's hand-off limit; the server takes it from any member who may edit the task. */
function HandoffLimitRow({ task }: PanelProps) {
  const can = useCan();
  if (!can.administer) return null;
  return (
    <PropRow label={t("prop.handoffLimit")}>
      <HandoffLimitField task={task} />
    </PropRow>
  );
}

export const handoffLimit = {
  name: "handoff_limit",
  title: () => t("prop.handoffLimit"),
  Panel: HandoffLimitRow,
  timeline: [
    {
      field: "handoff_limit",
      say: (c) => {
        const n = Number(c.to) || 0;
        return n ? t("timeline.handoffLimit", { n }) : t("timeline.handoffLimitCleared");
      },
    },
  ],
} satisfies TaskProperty<"handoff_limit">;

// The day a task is due, if any, picked in the date picker (ui/date-picker.tsx):
// typed in words, chosen from the common days by name (and, where the task's
// project works in cycles, the end of the current one, whose days the month
// tints; where it is in an epic, the epic's or its milestone's target), or
// from the month.

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useNow } from "@/data/live";
import { useCycles, useRow, useRowEvenIfGone } from "@/data/selectors";
import { addDays } from "@/lib/days";
import { t } from "@/lib/i18n";
import { dueLabel, formatDay, localDay, serverDay } from "@/lib/time";
import { endOfWeek, nextWeek, personWeek } from "@/lib/week";
import { isClosedCategory } from "@/types/core";
import { setDue } from "@/tasks/actions";
import { Pill, pill } from "@/tasks/properties/create-pill";
import { PickerRow } from "@/tasks/properties/panel-row";
import {
  asText,
  type CreateProps,
  type PanelProps,
  type PickerListProps,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
import { dueTone } from "@/tasks/task-chips";
import { DatePanel, type DatePanelProps, DatePicker } from "@/ui/date-picker";

/** What the tasks have in common that their due date is offered against. */
interface Around {
  projectId: string | undefined;
  epicId: string | undefined;
  milestoneId: string | undefined;
}

/**
 * The days a due date is offered by name, and the current cycle's days to
 * tint: Today, Tomorrow, the end of this week, next week, in two weeks; the
 * end of the current cycle where the project works in cycles; the
 * milestone's target and the epic's, where they have one.
 */
function useDueDays({ projectId, epicId, milestoneId }: Around): Pick<DatePanelProps, "quick" | "stretch"> {
  const now = useNow();
  const project = useRowEvenIfGone("projects", projectId);
  const cycles = useCycles(projectId);
  const epic = useRow("epics", epicId);
  const milestone = useRow("milestones", milestoneId);
  const today = localDay(now);
  // A cycle's days are the server's, as everywhere: the current one is the same for everybody.
  const day = serverDay(new Date(now));
  const current =
    projectId && project?.settings?.cycles ? cycles.find((c) => c.starts_on <= day && day <= c.ends_on) : undefined;
  return {
    quick: [
      { label: t("due.quick.today"), day: today },
      { label: t("due.quick.tomorrow"), day: addDays(today, 1) },
      { label: t("due.quick.endOfWeek"), day: endOfWeek(today, personWeek) },
      { label: t("due.quick.nextWeek"), day: nextWeek(today, personWeek) },
      { label: t("due.quick.inTwoWeeks"), day: addDays(today, 14) },
      ...(current ? [{ label: t("due.quick.endOfCycle"), day: current.ends_on }] : []),
      ...(milestone?.target_on ? [{ label: t("due.quick.milestoneTarget"), day: milestone.target_on }] : []),
      ...(epic?.target_on ? [{ label: t("due.quick.epicTarget"), day: epic.target_on }] : []),
    ],
    stretch: current && { from: current.starts_on, to: current.ends_on },
  };
}

/** The picker a key, the bulk bar or the panel's value opens, for one task or a whole selection. */
function DueList({ tasks, close }: PickerListProps) {
  const days = useDueDays({
    projectId: shared(tasks, (task) => task.project_id),
    epicId: shared(tasks, (task) => task.epic_id),
    milestoneId: shared(tasks, (task) => task.milestone_id),
  });
  return (
    <DatePanel
      {...days}
      label={tasks.length === 1 ? t("prop.due") : t("bulk.due.label", { n: tasks.length })}
      value={shared(tasks, (task) => task.due_on)}
      someSet={tasks.some((task) => !!task.due_on)}
      clearable
      onChange={(day) => {
        setDue(tasks, day);
        close();
      }}
    />
  );
}

/** The day, as the app writes days, and how near it is as the task list says it: "Today", "3d late". */
function DueRow(panel: PanelProps) {
  const { task } = panel;
  const status = useRowEvenIfGone("statuses", task.status_id);
  const day = task.due_on;
  const near = day ? dueLabel(day) : undefined;
  // Beyond the next few days the list says only the day, which the button says already.
  const word = day && near && near.text !== formatDay(day) ? near : undefined;
  const value = !day ? t("prop.noDue") : word ? `${formatDay(day)}, ${word.text}` : formatDay(day);
  return (
    <PickerRow property={due} panel={panel} value={value} empty={!day}>
      <CalendarDays className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate tnum">{day ? formatDay(day) : t("prop.noDue")}</span>
      {word && (
        <span className={dueTone(word.tone, isClosedCategory(status?.category))} aria-hidden>
          {word.text}
        </span>
      )}
    </PickerRow>
  );
}

/** The create dialog's pill: the day, or the property's name while none is set. */
function DuePill({ project, value, onChange }: CreateProps) {
  const [open, setOpen] = useState(false);
  const days = useDueDays({ projectId: project.id, epicId: value.epicId || undefined, milestoneId: undefined });
  return (
    <DatePicker
      {...days}
      open={open}
      onOpenChange={setOpen}
      label={t("prop.due")}
      value={value.dueOn || undefined}
      clearable
      onChange={(day) => onChange({ dueOn: day ?? "" })}
    >
      <button type="button" className={pill}>
        <Pill icon={<CalendarDays className="size-3.5" aria-hidden />} set={!!value.dueOn}>
          {value.dueOn ? formatDay(value.dueOn) : t("prop.due")}
        </Pill>
      </button>
    </DatePicker>
  );
}

export const due = {
  name: "due",
  title: () => t("prop.due"),
  key: { key: "shift+d", shortcut: "shortcuts.due" },
  picker: { title: () => t("prop.set.due"), List: DueList },
  Panel: DueRow,
  Create: DuePill,
  bulk: { place: "menu", icon: <CalendarDays />, label: () => t("bulk.due") },
  timeline: [
    {
      field: "due_on",
      say: (c) => (c.to ? t("timeline.due", { day: formatDay(asText(c.to)) }) : t("timeline.dueCleared")),
    },
  ],
} satisfies TaskProperty<"due">;

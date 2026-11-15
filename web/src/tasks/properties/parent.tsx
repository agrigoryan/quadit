// The task a task is a part of, if any: its parent, with the task as one of
// its sub-tasks.

import { useCallback, useMemo } from "react";
import { ArrowUpRight, CircleSlash, CornerLeftUp } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useLiveTasks, useLookupEvenIfGone, useRowEvenIfGone } from "@/data/selectors";
import { useTaskLink } from "@/lib/task-link";
import type { Task } from "@/types/core";
import { TaskPicker } from "@/detail/task-picker";
import { setParent } from "@/tasks/actions";
import { orNone, Pill, pill } from "@/tasks/properties/create-pill";
import { PropButton, PropRow } from "@/tasks/properties/panel-row";
import { asText, type CreateProps, type PanelProps, type TaskProperty } from "@/tasks/properties/property";
import { noneItem } from "@/tasks/property-picker";
import { Picker } from "@/ui/picker";
import { Tooltip } from "@/ui/tooltip";

const NO_PARENT = "none";

function OpenTaskLink({ task }: { task: Task }) {
  const link = useTaskLink(task);
  const label = t("detail.openParent", { key: task.key });
  return (
    <Tooltip label={label}>
      <Link
        {...link}
        aria-label={label}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-9"
      >
        <ArrowUpRight className="size-3.5" />
      </Link>
    </Tooltip>
  );
}

/** The task this one is a part of: any task of the same project that is not below it. */
function ParentField({ task }: { task: Task }) {
  // The parent is named even when it is in the trash or the archive.
  const parent = useRowEvenIfGone("tasks", task.parent_id);
  // Gone tasks count too: one restored later must not end up under its own sub-task.
  const tasks = useLookupEvenIfGone("tasks");
  const can = useCan();

  // A task cannot sit under itself or under anything that sits under it.
  const below = useMemo(() => {
    const children: Record<string, string[]> = {};
    for (const tk of Object.values(tasks)) if (tk.parent_id) (children[tk.parent_id] ??= []).push(tk.id);
    const out = new Set<string>([task.id]);
    const stack = [task.id];
    for (let id = stack.pop(); id; id = stack.pop()) {
      for (const child of children[id] ?? []) {
        if (!out.has(child)) {
          out.add(child);
          stack.push(child);
        }
      }
    }
    return out;
  }, [tasks, task.id]);

  const filter = useCallback(
    (tk: Task) => tk.project_id === task.project_id && !below.has(tk.id),
    [task.project_id, below],
  );
  const extra = useMemo(
    () => [
      { id: NO_PARENT, label: t("task.noParent"), icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden /> },
    ],
    [],
  );

  return (
    <>
      <TaskPicker
        filter={filter}
        value={task.parent_id ?? NO_PARENT}
        extra={extra}
        label={t("prop.set.parent")}
        onPick={(id) => setParent([task], id === NO_PARENT ? null : id)}
      >
        <PropButton
          empty={!parent}
          disabled={!can.editTask(task)}
          aria-label={`${t("prop.parent")}: ${parent ? parent.key : t("task.noParent")}`}
          // Room is left for the arrow that opens the parent, so a long title does not push it onto a line of its own.
          className={parent ? "max-w-[calc(100%-1.75rem)]" : undefined}
        >
          {parent ? (
            <>
              <span className="shrink-0 text-xs text-ink-3 tnum">{parent.key}</span>
              <span className="truncate">{parent.title}</span>
            </>
          ) : (
            t("task.noParent")
          )}
        </PropButton>
      </TaskPicker>
      {parent && <OpenTaskLink task={parent} />}
    </>
  );
}

function ParentRow({ task }: PanelProps) {
  return (
    <PropRow label={t("prop.parent")}>
      <ParentField task={task} />
    </PropRow>
  );
}

/** Any task of the project; left out when several tasks are made at once. */
function ParentPill({ project, value, onChange, shared }: CreateProps) {
  const tasks = useLiveTasks();
  if (shared) return null;
  const chosen = tasks.find((task) => task.id === value.parentId);
  return (
    <Picker
      label={t("prop.parent")}
      placeholder={t("prop.set.parent")}
      value={value.parentId || NO_PARENT}
      items={[
        noneItem(t("task.noParent")),
        ...tasks
          .filter((task) => task.project_id === project.id)
          .map((task) => ({ id: task.id, label: task.title, hint: task.key, keywords: task.key })),
      ]}
      onPick={(id) => onChange({ parentId: orNone(id) })}
    >
      <button type="button" className={pill}>
        <Pill icon={<CornerLeftUp className="size-3.5" aria-hidden />} set={!!chosen}>
          {chosen ? chosen.key : t("prop.parent")}
        </Pill>
      </button>
    </Picker>
  );
}

export const parent = {
  name: "parent",
  title: () => t("prop.parent"),
  Panel: ParentRow,
  Create: ParentPill,
  timeline: [
    {
      field: "parent_id",
      say: (c) => {
        const key = getRowEvenIfGone("tasks", asText(c.to))?.key;
        return key ? t("timeline.parent", { key }) : c.to ? null : t("timeline.parentCleared");
      },
    },
  ],
} satisfies TaskProperty<"parent">;

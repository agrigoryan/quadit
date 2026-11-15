// The list layout of a task page: the rows, drawn. Where the rows sit is
// tasks/list-layout.ts, which row the keyboard is on tasks/list-focus.ts,
// what is selected tasks/list-selection.ts, and the keys
// tasks/task-list-keys.ts.

import { useCallback, useMemo, useRef, useState } from "react";
import { usePeek } from "@/lib/task-link";
import type { Task } from "@/lib/types";
import type { NewTaskDraft } from "@/tasks/draft";
import { NONE, type TaskGroup } from "@/tasks/filters";
import { GroupHeader } from "@/tasks/group-header";
import { useListFocus, useListPlace } from "@/tasks/list-focus";
import { OVERSCAN, ROW, rowKey, rowsBetween, TAIL, useListLayout } from "@/tasks/list-layout";
import { useListSelection } from "@/tasks/list-selection";
import { type TaskProperty, TaskPropertyPicker } from "@/tasks/property-picker";
import { useTaskListKeys } from "@/tasks/task-list-keys";
import { keyColumn, TaskRow } from "@/tasks/task-row";
import { useViewport } from "@/tasks/use-viewport";

interface Props {
  groups: TaskGroup[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Opens the create dialog with these values filled in. */
  onAdd: (draft: NewTaskDraft) => void;
}

/** What a new task in this group starts with. */
function draftFor(group: TaskGroup): NewTaskDraft {
  if (group.kind === "status" && group.id === group.value && group.category !== group.value)
    return { statusId: group.value };
  if (group.kind === "assignee" && group.value !== NONE) return { assigneeId: group.value };
  if (group.kind === "epic" && group.value !== NONE) return { epicId: group.value };
  if (group.kind === "label" && group.value !== NONE) return { labelIds: [group.value] };
  return {};
}

// What a row leaves out because its group heading already says it.
const HIDE_EPIC = { epic: true };
const HIDE_ASSIGNEE = { assignee: true };

/**
 * Tasks as dense rows under collapsible group headings, driven from the
 * keyboard: J/K move, Space shows the focused task in the panel, Enter
 * opens its page, X selects, S/A/P/L change the focused row or the whole
 * selection. While the panel is open J/K move it to the next task, and
 * Space or Escape closes it with the focus still on the row. Only the rows
 * on screen are drawn, so the list stays quick at any length. Left for a
 * task's page and come back to, it is where it was (lib/place.ts).
 */
export function TaskList({ groups, selected, onSelectedChange, onAdd }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const place = useListPlace(scroller);
  const { folded, toggleFolded, focusKey, setFocusKey } = place;
  const layout = useListLayout(groups, folded);
  const focus = useListFocus(layout, place, scroller);
  const { targets, select } = useListSelection(layout, focus.focused, selected, onSelectedChange);
  const [picker, setPicker] = useState<TaskProperty | null>(null);
  const anchor = useRef<Element | null>(null);
  const view = useViewport(scroller);
  const peeking = usePeek().key !== undefined;

  function openPicker(kind: TaskProperty) {
    const first = targets[0];
    if (!first) return;
    // The row may be scrolled out of the window; the list itself then holds the picker.
    anchor.current = scroller.current?.querySelector(`[data-task="${first.id}"]`) ?? scroller.current;
    setPicker(kind);
  }

  useTaskListKeys({
    focus,
    focusKey,
    select,
    clearSelection: () => {
      if (selected.size > 0) onSelectedChange(new Set());
    },
    openPicker,
  });

  const keyStyle = useMemo(() => keyColumn(layout.rows.map((row) => row.task.key)), [layout.rows]);
  const hover = useCallback((task: Task, at?: string) => setFocusKey(at ?? task.id), [setFocusKey]);
  const addTo = useCallback((group: TaskGroup) => onAdd(draftFor(group)), [onAdd]);
  const from = view.top - OVERSCAN;
  const to = view.top + view.height + OVERSCAN;

  return (
    <div
      ref={scroller}
      className="h-full overflow-y-auto"
      style={keyStyle}
      onMouseLeave={() => !picker && !peeking && setFocusKey(null)}
    >
      <div className="relative" style={{ height: layout.total + TAIL }}>
        {layout.sections.map((section) => {
          if (section.top + section.height < from || section.top > to) return null;
          const { group } = section;
          const { start, end } = rowsBetween(section, from, to);
          const hide = group.kind === "epic" ? HIDE_EPIC : group.kind === "assignee" ? HIDE_ASSIGNEE : undefined;
          return (
            <section
              key={group.id}
              aria-label={group.title || undefined}
              className="absolute inset-x-0"
              style={{ top: section.top, height: section.height }}
            >
              {section.head > 0 && (
                <GroupHeader group={group} collapsed={folded.has(group.id)} onToggle={toggleFolded} onAdd={addTo} />
              )}
              {start > 0 && <div aria-hidden style={{ height: start * ROW }} />}
              {group.tasks.slice(start, end).map((task) => {
                const key = rowKey(group, task);
                return (
                  <TaskRow
                    key={key}
                    at={key}
                    task={task}
                    focused={key === focusKey}
                    selected={selected.has(task.id)}
                    onSelect={select}
                    onHover={hover}
                    hide={hide}
                  />
                );
              })}
            </section>
          );
        })}
      </div>
      {picker && targets.length > 0 && (
        <TaskPropertyPicker
          kind={picker}
          tasks={targets}
          open
          onOpenChange={(open) => !open && setPicker(null)}
          anchor={anchor}
        />
      )}
    </div>
  );
}

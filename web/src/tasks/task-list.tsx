// The list layout of a task page: rows under collapsible group headings,
// sub-tasks nested under their parents, driven from the keyboard. Where the
// groups and rows sit, and how a group's rows nest, is worked out in
// tasks/list-layout.ts; the keys shared with the board and the other lists
// are in tasks/panel-keys.ts.

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "@/lib/hotkeys";
import { usePlace } from "@/lib/place";
import { useCan } from "@/lib/access";
import { useLookup } from "@/lib/selectors";
import { isDraft } from "@/lib/store";
import { usePeek, useTaskNav } from "@/lib/task-link";
import { takeSeen, useTaskOrder } from "@/lib/task-queue";
import type { SortBy, Task } from "@/lib/types";
import type { NewTaskDraft } from "@/tasks/draft";
import { comparer, type TaskGroup } from "@/tasks/filters";
import { GroupHeader } from "@/tasks/group-header";
import {
  layOut,
  OVERSCAN,
  ROW,
  type Row,
  rowOfSameTask,
  rowPlace,
  rowsBetween,
  stepFrom,
  TAIL,
  treeStep,
} from "@/tasks/list-layout";
import { isOnControl, usePanelStepKeys } from "@/tasks/panel-keys";
import { GROUPINGS, KEYED } from "@/tasks/properties";
import type { PickerProperty } from "@/tasks/properties/property";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { keyColumn, TaskRow } from "@/tasks/task-row";
import { useViewport } from "@/tasks/use-viewport";

interface Props {
  groups: TaskGroup[];
  /** Sub-tasks under their parents, in the order `sort` gives; or every task a row of its group, in the groups' order. */
  nested: boolean;
  sort: SortBy;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Opens the create dialog with these values filled in; left out for someone who may not create tasks here. */
  onAdd?: (draft: NewTaskDraft) => void;
}

/** The property a group stands for (tasks/properties). */
const groupingOf = (group: TaskGroup) => GROUPINGS.find((p) => p.name === group.kind)?.group;

/**
 * Tasks as dense rows under collapsible group headings, driven from the
 * keyboard: J/K move, Space shows the focused task in the panel, Enter
 * opens its page, X selects, S/A/P/L change the focused row or the whole
 * selection, Left and Right fold and unfold a parent's sub-tasks. A parent
 * shown only for context (tasks/list-layout.ts) is walked and opened like
 * any row, but is never selected. While the panel is open J/K move it to the next task, and
 * Space or Escape closes it with the focus still on the row. Only the rows
 * on screen are drawn, so the list stays quick at any length. Left for a
 * task's page and come back to, it is where it was (lib/place.ts).
 */
export function TaskList({ groups, nested, sort, selected, onSelectedChange, onAdd }: Props) {
  const open = useTaskNav();
  const peek = usePeek();
  const peeking = peek.key !== undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const place = useRef({ focus: null as string | null, folded: [] as string[] });
  const saved = usePlace(scroller, () => place.current);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(saved?.folded));
  const [focusKey, setFocusKey] = useState<string | null>(saved?.focus ?? null);
  // Where the list is, for usePlace to keep as the list leaves.
  useLayoutEffect(() => {
    place.current = { focus: focusKey, folded: [...collapsed] };
  });
  const [picker, setPicker] = useState<PickerProperty | null>(null);
  const anchor = useRef<Element | null>(null);
  const lastPicked = useRef<string | null>(null);
  const view = useViewport(scroller);
  const tasks = useLookup("tasks");
  const can = useCan();

  // `collapsed` holds the groups folded, by id, and the parents folded, by row key.
  const { sections, rows, indexOf, total } = useMemo(
    () => layOut(groups, collapsed, nested ? { tasks, compare: comparer(sort) } : undefined),
    [groups, collapsed, nested, tasks, sort],
  );
  const keyStyle = useMemo(() => keyColumn(rows.map((row) => row.task.key)), [rows]);

  // The focused row's task moved to another group (S changed its status): the focus goes with it.
  const movedTo = focusKey !== null && !indexOf.has(focusKey) ? rowOfSameTask(rows, focusKey) : undefined;
  if (movedTo) setFocusKey(movedTo.key);
  const focusAt = focusKey === null ? -1 : (indexOf.get(focusKey) ?? -1);
  const focusedRow = rows[focusAt];
  const focused = focusedRow?.task;
  const targets = useMemo(() => {
    if (selected.size === 0) return focused ? [focused] : [];
    // Grouped by label a task can show twice; it is changed once.
    const picked = new Map<string, Task>();
    for (const row of rows) if (selected.has(row.task.id)) picked.set(row.task.id, row.task);
    return [...picked.values()];
  }, [rows, selected, focused]);

  // A selection only ever holds rows that are still on screen.
  useEffect(() => {
    if (selected.size === 0) return;
    const ids = new Set(rows.filter((row) => !row.branch?.context).map((row) => row.task.id));
    const kept = [...selected].filter((id) => ids.has(id));
    if (kept.length !== selected.size) onSelectedChange(new Set(kept));
  }, [rows, selected, onSelectedChange]);

  /** Makes the row at this position the focused one, and scrolls just far enough that it is in view, clear of its sticky heading. */
  function focusRow(index: number) {
    setFocusKey(rows[index]?.key ?? null);
    const el = scroller.current;
    const at = rowPlace(sections, index);
    if (!el || !at) return;
    if (at.top < el.scrollTop + at.head) el.scrollTop = at.top - at.head;
    else if (at.top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = at.top + ROW - el.clientHeight;
  }

  function move(step: number, from = focusAt): Row | undefined {
    if (rows.length === 0) return undefined;
    const at = stepFrom(from, step, rows.length);
    const next = rows[at];
    if (next) focusRow(at);
    return next;
  }

  // A task's page opened from here steps along these rows (lib/task-queue.ts). Come back to
  // from a page that stepped on, the focus is on the task it ended at.
  const listStep = useTaskOrder(() => rows.map((row) => row.task.key));
  const focusSeen = useEffectEvent((step: string) => {
    const key = takeSeen(step);
    const at = key ? rows.findIndex((row) => row.task.key === key) : -1;
    if (at >= 0) focusRow(at);
  });
  // oxlint-disable-next-line react/set-state-in-effect -- the task left in the module's memory is taken once, as the list comes back; an initializer may run twice, and a take cannot
  useLayoutEffect(() => focusSeen(listStep), [listStep]);

  /** Where the task in the panel is listed, when the focus is not on it. */
  const peekedAt = focused?.key === peek.key ? focusAt : rows.findIndex((row) => row.task.key === peek.key);
  /** The tasks this list asked the panel for, so their arrival is not taken for a move made elsewhere. */
  const asked = useRef(new Set<string>());

  function showInPanel(task: Task) {
    // A row not yet numbered by the server has nothing to show.
    if (isDraft(task.id)) return;
    asked.current.add(task.key);
    open.peek(task.key);
  }

  // The panel went to another task by other means (a sub-task opened inside it): the focus goes with it.
  const followPanel = useEffectEvent((key: string | undefined) => {
    if (key === undefined) {
      asked.current.clear();
      return;
    }
    if (asked.current.delete(key) || peekedAt < 0 || peekedAt === focusAt) return;
    focusRow(peekedAt);
  });
  useEffect(() => followPanel(peek.key), [peek.key]);

  const select = useCallback(
    (task: Task, range: boolean, at?: string) => {
      const key = at ?? task.id;
      const next = new Set(selected);
      const from = lastPicked.current;
      const a = from ? indexOf.get(from) : undefined;
      const b = indexOf.get(key);
      if (range && a !== undefined && b !== undefined) {
        for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1))
          if (!row.branch?.context) next.add(row.task.id);
      } else if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      lastPicked.current = key;
      onSelectedChange(next);
    },
    [selected, rows, indexOf, onSelectedChange],
  );

  const hover = useCallback((task: Task, at?: string) => setFocusKey(at ?? task.id), []);

  /** Folds or unfolds a group, by its id, or a parent's sub-tasks, by its row key. */
  const fold = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const toggle = useCallback((group: TaskGroup) => fold(group.id), [fold]);

  function stepTree(e: KeyboardEvent, by: number) {
    const to = treeStep(rows, focusAt, by);
    if (!to) return;
    e.preventDefault();
    if ("toggle" in to) fold(to.toggle);
    else focusRow(to.focus);
  }
  const addTo = useCallback((group: TaskGroup) => onAdd?.(groupingOf(group)?.draft?.(group) ?? {}), [onAdd]);

  function openPicker(property: PickerProperty) {
    const first = targets[0];
    // Like the row's own buttons: nothing to pick for a task the viewer may not change.
    if (!first || !targets.every((task) => can.editTask(task))) return;
    // The row may be scrolled out of the window; the list itself then holds the picker.
    anchor.current = scroller.current?.querySelector(`[data-task="${first.id}"]`) ?? scroller.current;
    setPicker(property);
  }

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    ArrowDown: (e) => {
      e.preventDefault();
      move(1);
    },
    ArrowUp: (e) => {
      e.preventDefault();
      move(-1);
    },
    Enter: () => {
      // A draft has no address yet.
      if (focused && !isDraft(focused.id)) open.page(focused.key);
    },
    " ": (e) => {
      if (!focused || isOnControl(e)) return;
      e.preventDefault(); // or the list scrolls a screen down
      showInPanel(focused);
    },
    ArrowLeft: (e) => stepTree(e, -1),
    ArrowRight: (e) => stepTree(e, 1),
    x: () => {
      // A parent shown only for context is not one of the list's tasks to select.
      if (focused && !focusedRow?.branch?.context) select(focused, false, focusKey ?? undefined);
    },
    Escape: () => {
      if (selected.size > 0) onSelectedChange(new Set());
    },
    ...Object.fromEntries(
      KEYED.map((property) => [
        property.picker.hotkey?.key,
        (e: KeyboardEvent) => {
          e.preventDefault(); // or the letter lands in the picker's search box
          openPicker(property);
        },
      ]),
    ),
  });

  // While the panel is open the same keys move it a row along. The focus leads and the panel follows, so keys pressed quickly are all counted.
  usePanelStepKeys({
    onStep: (step) => {
      const next = move(step, focusAt < 0 ? peekedAt : focusAt);
      if (next) showInPanel(next.task);
    },
  });

  const from = view.top - OVERSCAN;
  const to = view.top + view.height + OVERSCAN;

  return (
    <div
      ref={scroller}
      className="h-full overflow-y-auto"
      style={keyStyle}
      onMouseLeave={() => !picker && !peeking && setFocusKey(null)}
    >
      <div className="relative" style={{ height: total + TAIL }}>
        {sections.map((section) => {
          if (section.top + section.height < from || section.top > to) return null;
          const { group } = section;
          const { start, end } = rowsBetween(section, from, to);
          // What a row leaves out because its group heading already says it.
          const hide = groupingOf(group)?.hides;
          return (
            <section
              key={group.id}
              aria-label={group.title || undefined}
              className="absolute inset-x-0"
              style={{ top: section.top, height: section.height }}
            >
              {section.head > 0 && (
                <GroupHeader
                  group={group}
                  collapsed={collapsed.has(group.id)}
                  onToggle={toggle}
                  onAdd={onAdd && addTo}
                />
              )}
              {/* Nested, the rows are announced as a list whose items carry their level in the tree. */}
              <div role={rows[section.first]?.branch ? "list" : undefined}>
                {start > 0 && <div aria-hidden style={{ height: start * ROW }} />}
                {rows.slice(section.first + start, section.first + end).map(({ key, task, branch }) => (
                  <TaskRow
                    key={key}
                    at={key}
                    task={task}
                    branch={branch}
                    focused={key === focusKey}
                    selected={!branch?.context && selected.has(task.id)}
                    onSelect={select}
                    onHover={hover}
                    onFold={fold}
                    hide={hide}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {picker && targets.length > 0 && (
        <TaskPropertyPicker
          property={picker}
          tasks={targets}
          open
          onOpenChange={(open) => !open && setPicker(null)}
          anchor={anchor}
        />
      )}
    </div>
  );
}

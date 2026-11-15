import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useHotkeys } from "@/lib/hotkeys";
import { isDraft, useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import type { NewTaskDraft } from "@/tasks/draft";
import { NONE, type TaskGroup } from "@/tasks/filters";
import { GroupHeader } from "@/tasks/group-header";
import { type TaskProperty, TaskPropertyPicker } from "@/tasks/property-picker";
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
  if (group.kind === "status" && group.id === group.value && group.category !== group.value) return { statusId: group.value };
  if (group.kind === "assignee" && group.value !== NONE) return { assigneeId: group.value };
  if (group.kind === "epic" && group.value !== NONE) return { epicId: group.value };
  if (group.kind === "label" && group.value !== NONE) return { labelIds: [group.value] };
  return {};
}

// What a row leaves out because its group heading already says it.
const HIDE_EPIC = { epic: true };
const HIDE_ASSIGNEE = { assignee: true };

const KEY_TO_PROPERTY: Record<string, TaskProperty> = { s: "status", a: "assignee", p: "priority", l: "labels" };

// Heights in pixels of a row (h-9) and a group heading (h-8), and how far past the edges rows are kept drawn.
const ROW = 36;
const HEAD = 32;
const OVERSCAN = 8 * ROW;
/** Room under the last row, so the bulk bar never covers it. */
const TAIL = 96;

/** Where one group sits in the full height of the list. */
interface Section {
  group: TaskGroup;
  top: number;
  head: number;
  /** Rows it shows: none while folded. */
  rows: number;
  height: number;
  /** The position of its first row among all the rows showing. */
  first: number;
}

/** One row on screen: grouped by label, a task can be in the list more than once, so a row is a task in a group. */
interface Row {
  key: string;
  task: Task;
}

const rowKey = (group: TaskGroup, task: Task) => `${group.id}:${task.id}`;

/**
 * Tasks as dense rows under collapsible group headings, driven from the
 * keyboard: J/K move, Enter opens, X selects, S/A/P/L change the focused
 * row or the whole selection. Only the rows on screen are drawn, so the
 * list stays quick at any length.
 */
export function TaskList({ groups, selected, onSelectedChange, onAdd }: Props) {
  const slug = useStore((s) => s.slug);
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [picker, setPicker] = useState<TaskProperty | null>(null);
  const anchor = useRef<Element | null>(null);
  const lastPicked = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const view = useViewport(scroller);

  const { sections, rows, indexOf, total } = useMemo(() => {
    const sections: Section[] = [];
    const rows: Row[] = [];
    const indexOf = new Map<string, number>();
    let top = 0;
    for (const group of groups) {
      const head = group.kind === "none" ? 0 : HEAD;
      const shown = collapsed.has(group.id) ? 0 : group.tasks.length;
      const first = rows.length;
      if (shown) {
        for (const task of group.tasks) {
          const key = rowKey(group, task);
          indexOf.set(key, rows.length);
          rows.push({ key, task });
        }
      }
      const height = head + shown * ROW;
      sections.push({ group, top, head, rows: shown, height, first });
      top += height;
    }
    return { sections, rows, indexOf, total: top };
  }, [groups, collapsed]);

  const keyStyle = useMemo(() => keyColumn(rows.map((row) => row.task.key)), [rows]);

  const focusAt = focusKey === null ? -1 : (indexOf.get(focusKey) ?? -1);
  const focused = rows[focusAt]?.task;
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
    const ids = new Set(rows.map((row) => row.task.id));
    const kept = [...selected].filter((id) => ids.has(id));
    if (kept.length !== selected.size) onSelectedChange(new Set(kept));
  }, [rows, selected, onSelectedChange]);

  /** Scrolls just far enough that the row at this position is in view, clear of its sticky heading. */
  function reveal(index: number) {
    const el = scroller.current;
    const section = sections.findLast((s) => s.first <= index && s.rows > 0);
    if (!el || !section) return;
    const top = section.top + section.head + (index - section.first) * ROW;
    if (top < el.scrollTop + section.head) el.scrollTop = top - section.head;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }

  function move(step: number) {
    if (rows.length === 0) return;
    const at = Math.max(0, Math.min(rows.length - 1, focusAt < 0 ? (step > 0 ? 0 : rows.length - 1) : focusAt + step));
    const next = rows[at];
    if (!next) return;
    setFocusKey(next.key);
    reveal(at);
  }

  const select = useCallback(
    (task: Task, range: boolean, at?: string) => {
      const key = at ?? task.id;
      const next = new Set(selected);
      const from = lastPicked.current;
      const a = from ? indexOf.get(from) : undefined;
      const b = indexOf.get(key);
      if (range && a !== undefined && b !== undefined) {
        for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(row.task.id);
      } else if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      lastPicked.current = key;
      onSelectedChange(next);
    },
    [selected, rows, indexOf, onSelectedChange],
  );

  const hover = useCallback((task: Task, at?: string) => setFocusKey(at ?? task.id), []);

  const toggle = useCallback(
    (group: TaskGroup) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(group.id)) next.add(group.id);
        return next;
      }),
    [],
  );
  const addTo = useCallback((group: TaskGroup) => onAdd(draftFor(group)), [onAdd]);

  function openPicker(kind: TaskProperty) {
    const first = targets[0];
    if (!first) return;
    // The row may be scrolled out of the window; the list itself then holds the picker.
    anchor.current = scroller.current?.querySelector(`[data-task="${first.id}"]`) ?? scroller.current;
    setPicker(kind);
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
    // A draft has no address yet.
    Enter: () => focused && !isDraft(focused.id) && navigate(`/${slug}/task/${focused.key}`, { state: { background: location } }),
    x: () => focused && select(focused, false, focusKey ?? undefined),
    Escape: () => selected.size > 0 && onSelectedChange(new Set()),
    ...Object.fromEntries(
      Object.entries(KEY_TO_PROPERTY).map(([key, kind]) => [
        key,
        (e: KeyboardEvent) => {
          e.preventDefault(); // or the letter lands in the picker's search box
          openPicker(kind);
        },
      ]),
    ),
  });

  const from = view.top - OVERSCAN;
  const to = view.top + view.height + OVERSCAN;

  return (
    <div ref={scroller} className="h-full overflow-y-auto" style={keyStyle} onMouseLeave={() => !picker && setFocusKey(null)}>
      <div className="relative" style={{ height: total + TAIL }}>
        {sections.map((section) => {
          if (section.top + section.height < from || section.top > to) return null;
          const { group } = section;
          const body = section.top + section.head;
          const start = Math.max(0, Math.min(section.rows, Math.floor((from - body) / ROW)));
          const end = Math.max(start, Math.min(section.rows, Math.ceil((to - body) / ROW)));
          const hide = group.kind === "epic" ? HIDE_EPIC : group.kind === "assignee" ? HIDE_ASSIGNEE : undefined;
          return (
            <section
              key={group.id}
              aria-label={group.title || undefined}
              className="absolute inset-x-0"
              style={{ top: section.top, height: section.height }}
            >
              {section.head > 0 && <GroupHeader group={group} collapsed={collapsed.has(group.id)} onToggle={toggle} onAdd={addTo} />}
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
        <TaskPropertyPicker kind={picker} tasks={targets} open onOpenChange={(open) => !open && setPicker(null)} anchor={anchor} />
      )}
    </div>
  );
}

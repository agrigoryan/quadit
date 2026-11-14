import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useHotkeys } from "@/lib/hotkeys";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import type { TaskDraft } from "@/lib/ui-state";
import { NONE, type TaskGroup } from "@/tasks/filters";
import { GroupHeader } from "@/tasks/group-header";
import { type TaskProperty, TaskPropertyPicker } from "@/tasks/property-picker";
import { TaskRow } from "@/tasks/task-row";

interface Props {
  groups: TaskGroup[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Opens the create dialog with these values filled in. */
  onAdd: (draft: TaskDraft) => void;
}

/** What a new task in this group starts with. */
function draftFor(group: TaskGroup): TaskDraft {
  if (group.kind === "status" && group.id === group.value && group.category !== group.value) return { statusId: group.value };
  if (group.kind === "assignee" && group.value !== NONE) return { assigneeId: group.value };
  if (group.kind === "epic" && group.value !== NONE) return { epicId: group.value };
  return {};
}

// What a row leaves out because its group heading already says it.
const HIDE_EPIC = { epic: true };
const HIDE_ASSIGNEE = { assignee: true };

const KEY_TO_PROPERTY: Record<string, TaskProperty> = { s: "status", a: "assignee", p: "priority", l: "labels" };

/**
 * Tasks as dense rows under collapsible group headings, driven from the
 * keyboard: J/K move, Enter opens, X selects, S/A/P/L change the focused
 * row or the whole selection.
 */
export function TaskList({ groups, selected, onSelectedChange, onAdd }: Props) {
  const slug = useStore((s) => s.slug);
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [picker, setPicker] = useState<TaskProperty | null>(null);
  const anchor = useRef<Element | null>(null);
  const lastPicked = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => groups.flatMap((g) => (collapsed.has(g.id) ? [] : g.tasks)), [groups, collapsed]);
  const focused = visible.find((task) => task.id === focusId);
  const targets = useMemo(
    () => (selected.size > 0 ? visible.filter((task) => selected.has(task.id)) : focused ? [focused] : []),
    [visible, selected, focused],
  );

  // A selection only ever holds rows that are still on screen.
  useEffect(() => {
    if (selected.size === 0) return;
    const ids = new Set(visible.map((task) => task.id));
    const kept = [...selected].filter((id) => ids.has(id));
    if (kept.length !== selected.size) onSelectedChange(new Set(kept));
  }, [visible, selected, onSelectedChange]);

  const rowOf = (id: string) => root.current?.querySelector(`[data-task="${id}"]`) ?? null;

  function move(step: number) {
    if (visible.length === 0) return;
    const at = visible.findIndex((task) => task.id === focusId);
    const next = visible[Math.max(0, Math.min(visible.length - 1, at < 0 ? (step > 0 ? 0 : visible.length - 1) : at + step))];
    if (!next) return;
    setFocusId(next.id);
    rowOf(next.id)?.scrollIntoView({ block: "nearest" });
  }

  const select = useCallback(
    (task: Task, range: boolean) => {
      const next = new Set(selected);
      const from = lastPicked.current;
      if (range && from) {
        const a = visible.findIndex((v) => v.id === from);
        const b = visible.findIndex((v) => v.id === task.id);
        if (a >= 0 && b >= 0) for (const v of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(v.id);
      } else if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      lastPicked.current = task.id;
      onSelectedChange(next);
    },
    [selected, visible, onSelectedChange],
  );

  const hover = useCallback((task: Task) => setFocusId(task.id), []);

  function openPicker(kind: TaskProperty) {
    const first = targets[0];
    if (!first) return;
    anchor.current = rowOf(first.id);
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
      Enter: () => focused && navigate(`/${slug}/task/${focused.key}`, { state: { background: location } }),
      x: () => focused && select(focused, false),
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

  return (
    <div ref={root} className="pb-24" onMouseLeave={() => !picker && setFocusId(null)}>
      {groups.map((group) => (
        <section key={group.id} aria-label={group.title || undefined}>
          {group.kind !== "none" && (
            <GroupHeader
              group={group}
              collapsed={collapsed.has(group.id)}
              onToggle={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(group.id)) next.add(group.id);
                  return next;
                })
              }
              onAdd={() => onAdd(draftFor(group))}
            />
          )}
          {!collapsed.has(group.id) &&
            group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                focused={task.id === focusId}
                selected={selected.has(task.id)}
                onSelect={select}
                onHover={hover}
                hide={group.kind === "epic" ? HIDE_EPIC : group.kind === "assignee" ? HIDE_ASSIGNEE : undefined}
              />
            ))}
        </section>
      ))}
      {picker && targets.length > 0 && (
        <TaskPropertyPicker kind={picker} tasks={targets} open onOpenChange={(open) => !open && setPicker(null)} anchor={anchor} />
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { rankBetween } from "@/lib/rank";
import { statusesOf } from "@/lib/selectors";
import { getState } from "@/lib/store";
import type { Task } from "@/lib/types";
import { moveTask } from "@/tasks/actions";
import { CardOverlay } from "@/tasks/board-card";
import { BoardColumn } from "@/tasks/board-column";
import type { TaskGroup } from "@/tasks/filters";

interface Props {
  /** One group per column: the project's statuses in rank order (or the six categories across projects). */
  groups: TaskGroup[];
  projectId: string | undefined;
}

type Order = Record<string, string[]>;

/** The status a task takes when dropped in a column. A category column maps to the task's own project. */
function statusOf(group: TaskGroup, task: Task): string | undefined {
  const { statuses } = getState().c;
  if (statuses[group.value]) return group.value;
  return statusesOf(statuses, task.project_id).find((s) => s.category === group.value)?.id;
}

/**
 * Tasks as cards in columns by status. Dragging a card within a column
 * gives it a new rank between its neighbours; dragging it to another column
 * also changes its status. Both go out as one task.update.
 */
export function Board({ groups, projectId }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // While a card is being dragged the columns follow the pointer, not the store.
  const [order, setOrder] = useState<Order | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const g of groups) for (const task of g.tasks) map.set(task.id, task);
    return map;
  }, [groups]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    // Space lifts and drops a card; Enter is left alone so it still opens the task.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const columnOf = (o: Order, id: string) => (id in o ? id : Object.keys(o).find((col) => o[col]?.includes(id)));

  function start(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    setOrder(Object.fromEntries(groups.map((g) => [g.id, g.tasks.map((task) => task.id)])));
  }

  function over(e: DragOverEvent) {
    if (!order || !e.over) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const from = columnOf(order, id);
    const to = columnOf(order, overId);
    if (!from || !to || from === to) return;
    // Crossing into another column: put the card where the pointer is.
    const target = order[to] ?? [];
    const at = overId === to ? target.length : Math.max(0, target.indexOf(overId));
    setOrder({ ...order, [from]: (order[from] ?? []).filter((v) => v !== id), [to]: [...target.slice(0, at), id, ...target.slice(at)] });
  }

  function end(e: DragEndEvent) {
    const current = order;
    setActiveId(null);
    setOrder(null);
    if (!current || !e.over) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const col = columnOf(current, id);
    const task = byId.get(id);
    const group = groups.find((g) => g.id === col);
    if (!col || !task || !group) return;

    let ids = current[col] ?? [];
    const from = ids.indexOf(id);
    const to = ids.indexOf(overId);
    if (to >= 0 && to !== from) ids = arrayMove(ids, from, to);
    const at = ids.indexOf(id);
    const above = byId.get(ids[at - 1] ?? "");
    const below = byId.get(ids[at + 1] ?? "");
    const statusId = statusOf(group, task);
    if (!statusId) return;

    const moved = statusId !== task.status_id;
    const unchanged = !moved && (!above || above.rank < task.rank) && (!below || task.rank < below.rank);
    if (unchanged) return;
    moveTask(task, statusId, rankBetween(above?.rank, below?.rank));
  }

  const active = activeId ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={start}
      onDragOver={over}
      onDragEnd={end}
      onDragCancel={() => {
        setActiveId(null);
        setOrder(null);
      }}
    >
      <div className="flex h-full gap-2.5 overflow-x-auto p-2.5 max-sm:snap-x max-sm:snap-mandatory md:p-3">
        {groups.map((group) => {
          const tasks = order ? ((order[group.id] ?? []).map((id) => byId.get(id)).filter(Boolean) as Task[]) : group.tasks;
          return (
            <div key={group.id} className="h-full max-sm:snap-center">
              <BoardColumn group={group} tasks={tasks} projectId={projectId} />
            </div>
          );
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>{active && <CardOverlay task={active} />}</DragOverlay>
    </DndContext>
  );
}

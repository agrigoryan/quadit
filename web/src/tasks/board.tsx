import { useMemo, useRef, useState } from "react";
import {
  type Announcements,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type ClientRect,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, hasSortableData, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { t } from "@/lib/i18n";
import { rankBetween } from "@/lib/rank";
import { useCan } from "@/data/access";
import { getRow } from "@/data/selectors";
import type { Project, Task } from "@/types/core";
import { type CardMove, moveCard } from "@/tasks/actions";
import { AddStatusColumn } from "@/tasks/add-status";
import { CardOverlay } from "@/tasks/board-card";
import { BoardColumn, type Card } from "@/tasks/board-column";
import { useBoardKeys } from "@/tasks/board-keys";
import { projectStatuses } from "@/tasks/data";
import type { TaskGroup } from "@/tasks/filters";
import { NONE } from "@/tasks/properties/property";

interface Props {
  /**
   * One group per column: the project's statuses in rank order (the six
   * categories across projects), or its assignees, or its labels.
   */
  groups: TaskGroup[];
  /** The one project the board is about, when it is about one. */
  project: Project | undefined;
}

type Order = Record<string, string[]>;

/**
 * Lifting a card from the keyboard. Space alone is the quick look
 * (tasks/board-keys.ts), so a card is lifted with Shift+Space; the arrows
 * then move it, Space drops it and Escape puts it back.
 */
class LiftSensor extends KeyboardSensor {
  static activators: typeof KeyboardSensor.activators = KeyboardSensor.activators.map((activator) => ({
    ...activator,
    handler: (event, options, context) => event.nativeEvent.shiftKey && activator.handler(event, options, context),
  }));
}

/**
 * Where the arrows take a lifted card. Up and down are dnd-kit's own, within
 * the column. Left and right go to the column beside, to the card nearest the
 * same height, or to the top of the column when it is empty. dnd-kit's own
 * takes "to the right" to mean "left edge further right": the lifted card is
 * drawn tilted, a little wider than the cards it lies among, so the other
 * cards of its own column counted as to the right and it never left them.
 */
export const boardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const across = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
  if (across === 0) return sortableKeyboardCoordinates(event, args);
  event.preventDefault();
  const { collisionRect, droppableContainers, droppableRects } = args.context;
  if (!collisionRect) return undefined;
  const columns: ClientRect[] = [];
  const cards: ClientRect[] = [];
  for (const entry of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(entry.id);
    if (!rect || entry.id === args.active) continue;
    (hasSortableData(entry) ? cards : columns).push(rect);
  }
  columns.sort((a, b) => a.left - b.left);
  const middle = collisionRect.left + collisionRect.width / 2;
  const at = columns.findIndex((column) => column.left <= middle && middle < column.right);
  const column = at < 0 ? undefined : columns[at + across];
  if (!column) return undefined;
  const inColumn = cards.filter((card) => column.left <= card.left && card.right <= column.right);
  const distance = (card: ClientRect) => Math.abs(card.top - collisionRect.top);
  const nearest = inColumn.reduce<ClientRect | undefined>(
    (best, card) => (!best || distance(card) < distance(best) ? card : best),
    undefined,
  );
  const to = nearest ?? column;
  return { x: to.left, y: to.top };
};

/**
 * What a dragged card is over. The column is the one under the pointer (from
 * the keyboard, under the card's middle), or the nearer of the two it is
 * between; within it, the card nearest the dragged one, or the column itself
 * when it has none. Outside the board, nothing.
 *
 * The column comes from the pointer alone because the cards move under it:
 * once over another column the card is put there (Board's onDragOver). Asked
 * of every card on the board, as dnd-kit's closestCorners does, the answer
 * halfway between two columns was the card's neighbour in the column it had
 * just left, which took its place there; it was moved back, and forth again,
 * with every drawing, until React gave up (error #185). And a tall column
 * with few cards was never nearer than the card's own place, so the card
 * could not be dropped in the column beside.
 */
export const boardCollision: CollisionDetection = (args) => {
  const { collisionRect, droppableContainers, droppableRects } = args;
  const point = args.pointerCoordinates ?? {
    x: collisionRect.left + collisionRect.width / 2,
    y: collisionRect.top + collisionRect.height / 2,
  };
  const columns = droppableContainers.flatMap((entry) => {
    const rect = droppableRects.get(entry.id);
    return rect && !hasSortableData(entry) ? [{ entry, rect }] : [];
  });
  const inBoard =
    columns.some(({ rect }) => rect.left <= point.x) &&
    columns.some(({ rect }) => point.x <= rect.right) &&
    columns.some(({ rect }) => rect.top <= point.y && point.y <= rect.bottom);
  if (!inBoard) return [];
  const away = ({ rect }: { rect: ClientRect }) => Math.max(rect.left - point.x, point.x - rect.right, 0);
  const column = columns.reduce((best, next) => (away(next) < away(best) ? next : best));
  const cards = droppableContainers.filter(
    (entry) => hasSortableData(entry) && entry.data.current.sortable.containerId === column.entry.id,
  );
  if (cards.length === 0) return [{ id: column.entry.id, data: { droppableContainer: column.entry, value: 0 } }];
  return closestCorners({ ...args, droppableContainers: cards });
};

/** Grouped by label a task can be in two columns, so a card is a task in a column. */
const cardId = (group: TaskGroup, task: Task) => `${group.id}|${task.id}`;

/** The status a task takes when dropped in a column. A category column maps to the task's own project. */
function statusOf(group: TaskGroup, task: Task): string | undefined {
  if (getRow("statuses", group.value)) return group.value;
  return projectStatuses(task.project_id).find((s) => s.category === group.value)?.id;
}

/** What landing in `to` changes for a card that started in `from`. Nothing (null) when the column cannot take it. */
function changeFor(task: Task, from: TaskGroup, to: TaskGroup): CardMove | null {
  if (to.kind === "status") {
    const statusId = statusOf(to, task);
    return statusId ? { statusId } : null;
  }
  if (to.kind === "assignee") return { assigneeId: to.value === NONE ? null : to.value };
  if (to.kind === "label") {
    if (from.id === to.id) return {};
    // The label of the column it left is swapped for the label of the column it lands in.
    return {
      removeLabel: from.value === NONE ? undefined : from.value,
      addLabel: to.value === NONE ? undefined : to.value,
    };
  }
  return {};
}

/**
 * Tasks as cards in columns. Dragging a card within a column gives it a new
 * rank between its neighbours; dragging it to another column also gives it
 * what that column stands for. Both go out as one task.update. Each column
 * draws only the cards in view. The keys that look at a task are in
 * tasks/board-keys.ts.
 */
export function Board({ groups, project }: Props) {
  const can = useCan();
  const [activeId, setActiveId] = useState<string | null>(null);
  // While a card is being dragged the columns follow the pointer, not the store.
  const [order, setOrder] = useState<Order | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useBoardKeys(groups, scroller, activeId !== null);

  const { cards, byGroup } = useMemo(() => {
    const cards = new Map<string, Card & { group: TaskGroup }>();
    const byGroup = new Map<string, Card[]>();
    for (const group of groups) {
      const list = group.tasks.map((task) => ({ id: cardId(group, task), task }));
      byGroup.set(group.id, list);
      for (const card of list) cards.set(card.id, { ...card, group });
    }
    return { cards, byGroup };
  }, [groups]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(LiftSensor, {
      coordinateGetter: boardCoordinates,
      // A column beyond the middle of the board is reached by scrolling the board. A smooth scroll
      // asked for during the drag never ran (no scroll followed), and the card stayed where it was.
      scrollBehavior: "auto",
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const columnOf = (o: Order, id: string) => (id in o ? id : Object.keys(o).find((col) => o[col]?.includes(id)));

  function start(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    setOrder(Object.fromEntries(groups.map((g) => [g.id, (byGroup.get(g.id) ?? []).map((card) => card.id)])));
  }

  function over(e: DragOverEvent) {
    if (!order || !e.over) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const from = columnOf(order, id);
    const to = columnOf(order, overId);
    if (!from || !to || from === to) return;
    // Crossing into another column: put the card where it is, before the card it is over, or after
    // it when it is all below it (below the column's last card).
    const target = order[to] ?? [];
    const dragged = e.active.rect.current.translated;
    const below = !!dragged && dragged.top > e.over.rect.bottom;
    const at = overId === to ? target.length : Math.max(0, target.indexOf(overId)) + (below ? 1 : 0);
    setOrder({
      ...order,
      [from]: (order[from] ?? []).filter((v) => v !== id),
      [to]: [...target.slice(0, at), id, ...target.slice(at)],
    });
  }

  function end(e: DragEndEvent) {
    const current = order;
    setActiveId(null);
    setOrder(null);
    if (!current || !e.over) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const col = columnOf(current, id);
    const card = cards.get(id);
    const group = groups.find((g) => g.id === col);
    if (!col || !card || !group) return;
    const { task } = card;

    let ids = current[col] ?? [];
    const from = ids.indexOf(id);
    const to = ids.indexOf(overId);
    if (to >= 0 && to !== from) ids = arrayMove(ids, from, to);
    // Its neighbours in the new place; the same task shown twice in a column is no neighbour of itself.
    const others = ids.filter((v) => v === id || cards.get(v)?.task.id !== task.id);
    const at = others.indexOf(id);
    const above = cards.get(others[at - 1] ?? "")?.task;
    const below = cards.get(others[at + 1] ?? "")?.task;

    const change = changeFor(task, card.group, group);
    if (!change) return;
    const inPlace = (!above || above.rank < task.rank) && (!below || task.rank < below.rank);
    moveCard(task, inPlace ? undefined : rankBetween(above?.rank, below?.rank), change);
  }

  // What a screen reader hears while a card moves: the task and the column, in words. A card that
  // crossed into a column is drawn there and is over itself, so a column is looked up in `order`;
  // over itself it has not gone anywhere new, and the last words stand.
  const taskName = (id: UniqueIdentifier) => {
    const task = cards.get(String(id))?.task;
    return task ? `${task.key} ${task.title}` : "";
  };
  const columnName = (id: UniqueIdentifier) => {
    const col = (order && columnOf(order, String(id))) ?? cards.get(String(id))?.group.id ?? String(id);
    return groups.find((g) => g.id === col)?.title ?? "";
  };
  const back = (active: { id: UniqueIdentifier }) =>
    t("board.drag.cancel", { task: taskName(active.id), column: cards.get(String(active.id))?.group.title ?? "" });
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("board.drag.start", { task: taskName(active.id), column: cards.get(String(active.id))?.group.title ?? "" }),
    onDragOver: ({ active, over }) =>
      over?.id === active.id
        ? undefined
        : over
          ? t("board.drag.over", { task: taskName(active.id), column: columnName(over.id) })
          : t("board.drag.away", { task: taskName(active.id) }),
    onDragEnd: ({ active, over }) =>
      over ? t("board.drag.end", { task: taskName(active.id), column: columnName(over.id) }) : back(active),
    onDragCancel: ({ active }) => back(active),
  };

  const active = activeId ? cards.get(activeId)?.task : undefined;
  // Statuses are edited where they are used: on a project's board, by those who may.
  const editable = !!project && can.administer && groups[0]?.kind === "status";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      onDragStart={start}
      onDragOver={over}
      onDragEnd={end}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("board.dragKeys") } }}
      onDragCancel={() => {
        setActiveId(null);
        setOrder(null);
      }}
    >
      <div
        ref={scroller}
        {...keys.handlers}
        className="flex h-full gap-2.5 overflow-x-auto p-2.5 max-sm:snap-x max-sm:snap-mandatory md:p-3"
      >
        {groups.map((group) => {
          const list = order
            ? ((order[group.id] ?? []).map((id) => cards.get(id)).filter(Boolean) as Card[])
            : (byGroup.get(group.id) ?? []);
          return (
            <div key={group.id} data-column={group.id} className="h-full max-sm:snap-center">
              <BoardColumn group={group} cards={list} project={project} activeId={activeId} editable={editable} />
            </div>
          );
        })}
        {editable && project && (
          <div className="h-full max-sm:snap-center">
            <AddStatusColumn project={project} />
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>
        {active && <CardOverlay task={active} />}
      </DragOverlay>
      {keys.picker}
    </DndContext>
  );
}

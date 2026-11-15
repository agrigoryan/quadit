import { type FormEvent, useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, SquareKanban } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatNumber, t } from "@/lib/i18n";
import { rankBetween } from "@/lib/rank";
import { createProperty, moveRow, setViewConfig } from "@/docs/db/actions";
import { asList } from "@/docs/db/cell-value";
import type { Value } from "@/docs/db/formula";
import { OptionChip, optionsOf } from "@/docs/db/options";
import { RowCardBody } from "@/docs/db/row-card";
import { shownProps, type ViewProps } from "@/docs/db/use-table";
import type { DBProperty, Doc, SelectOption } from "@/lib/types-docs";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

const NONE = "col:";
const colId = (name: string) => `col:${name}`;
type Order = Record<string, string[]>;

const shell = "block w-full rounded-md border border-line bg-surface p-2.5 text-left shadow-card";

interface CardProps {
  row: Doc;
  cells: Record<string, Value> | undefined;
  props: DBProperty[];
  onOpen: (rowId: string) => void;
  /** Cards open, they do not move, and columns take no new ones. */
  readOnly: boolean;
}

function Card({ row, cells, props, onOpen, readOnly }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: readOnly,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        shell,
        "cursor-default touch-manipulation outline-offset-2 hover:border-line-strong",
        isDragging && "opacity-35",
      )}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(row.id);
        else listeners?.onKeyDown?.(e);
      }}
    >
      <RowCardBody row={row} cells={cells} props={props} />
    </div>
  );
}

interface ColumnProps extends Omit<CardProps, "row" | "cells"> {
  id: string;
  option: SelectOption | null;
  rows: Doc[];
  allCells: Record<string, Record<string, Value>>;
  onAdd: (title: string) => void;
}

function Column({ id, option, rows, allCells, props, onOpen, onAdd, readOnly }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const name = option?.name ?? t("db.board.none");

  function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim());
    setTitle("");
  }

  return (
    <section
      aria-label={name}
      className="flex w-68 shrink-0 flex-col rounded-lg bg-sunken max-sm:w-[78vw] max-sm:snap-center"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-2.5">
        {option ? <OptionChip option={option} /> : <span className="text-sm font-medium text-ink-2">{name}</span>}
        <span className="flex-1 text-xs text-ink-3 tnum">{formatNumber(rows.length)}</span>
        {!readOnly && (
          <button
            type="button"
            aria-label={t("db.board.add", { name })}
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            className="flex size-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        )}
      </header>
      {adding && (
        <form onSubmit={add} className="px-2 pb-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            onBlur={() => !title.trim() && setAdding(false)}
            placeholder={t("db.board.addPlaceholder")}
            aria-label={t("db.board.add", { name })}
            className="h-8 w-full rounded-md border border-accent bg-surface px-2.5 text-sm outline-none ring-2 ring-accent/25"
          />
        </form>
      )}
      <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cx(
            "flex min-h-16 flex-1 flex-col gap-1.5 px-2 pb-2 transition-colors",
            isOver && rows.length === 0 && "rounded-b-lg bg-hover",
          )}
        >
          {rows.map((row) => (
            <Card key={row.id} row={row} cells={allCells[row.id]} props={props} onOpen={onOpen} readOnly={readOnly} />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

/**
 * Rows as cards in columns, one per option of a select property. Dragging a
 * card to another column changes the value; dragging it within a column
 * changes its place in the manual order.
 */
export function BoardView({ db, view, rows, onOpen, onAdd, readOnly }: ViewProps) {
  const selects = db.table.props.filter((p) => p.type === "select");
  const group = selects.find((p) => p.id === view.config?.group_by) ?? selects[0];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const options = group ? optionsOf(group) : [];
  const grouped = useMemo(() => {
    const out: Order = { [NONE]: [] };
    for (const o of options) out[colId(o.name)] = [];
    for (const r of rows) {
      const name = group ? asList(r.props?.[group.id])[0] : undefined;
      (out[name !== undefined && colId(name) in out ? colId(name) : NONE] as string[]).push(r.id);
    }
    return out;
  }, [rows, group, options]);

  if (!group) {
    const make = () => {
      const id = createProperty(db.table.doc.id, t("db.board.status"), "select", {
        options: [
          { name: t("db.board.todo"), color: "gray" },
          { name: t("db.board.doing"), color: "blue" },
          { name: t("db.board.done"), color: "green" },
        ],
      });
      setViewConfig(view, { group_by: id });
    };
    return (
      <EmptyState
        icon={<SquareKanban />}
        title={t("db.board.needsSelect")}
        hint={t("db.board.needsSelectHint")}
        action={!readOnly && <Button onClick={make}>{t("db.board.addStatus")}</Button>}
      />
    );
  }

  const cardProps = shownProps(db.table.props, view).filter((p) => p.id !== group.id);
  const columnOf = (o: Order, id: string) => (id in o ? id : Object.keys(o).find((col) => o[col]?.includes(id)));

  function over(e: DragOverEvent) {
    if (!order || !e.over) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const from = columnOf(order, id);
    const to = columnOf(order, overId);
    if (!from || !to || from === to) return;
    const target = order[to] ?? [];
    const at = overId === to ? target.length : Math.max(0, target.indexOf(overId));
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
    if (!current || !e.over || !group) return;
    const id = String(e.active.id);
    const overId = String(e.over.id);
    const col = columnOf(current, id);
    const row = byId.get(id);
    if (!col || !row) return;
    let ids = current[col] ?? [];
    const from = ids.indexOf(id);
    const to = ids.indexOf(overId);
    if (to >= 0 && to !== from) ids = arrayMove(ids, from, to);
    const at = ids.indexOf(id);
    const above = byId.get(ids[at - 1] ?? "");
    const below = byId.get(ids[at + 1] ?? "");
    const name = col.slice(NONE.length);
    const moved = col !== columnOf(grouped, id);
    const inPlace = (!above || above.rank < row.rank) && (!below || row.rank < below.rank);
    moveRow(
      row,
      inPlace ? row.rank : rankBetween(above?.rank, below?.rank),
      moved ? { [group.id]: name || null } : undefined,
    );
  }

  const shown = order ?? grouped;
  const active = activeId ? byId.get(activeId) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => {
        setActiveId(String(e.active.id));
        setOrder(grouped);
      }}
      onDragOver={over}
      onDragEnd={end}
      onDragCancel={() => {
        setActiveId(null);
        setOrder(null);
      }}
    >
      <div className="flex items-start gap-2.5 overflow-x-auto pt-1 pb-3 max-sm:snap-x max-sm:snap-mandatory">
        {[null, ...options].map((option) => {
          const id = option ? colId(option.name) : NONE;
          const list = (shown[id] ?? []).map((rid) => byId.get(rid)).filter((r): r is Doc => !!r);
          return (
            <Column
              key={id}
              id={id}
              option={option}
              rows={list}
              allCells={db.cells}
              props={cardProps}
              onOpen={onOpen}
              onAdd={(title) => onAdd(option ? { [group.id]: option.name } : undefined, title)}
              readOnly={readOnly}
            />
          );
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>
        {active && (
          <RowCardBody
            row={active}
            cells={db.cells[active.id]}
            props={cardProps}
            className={cx(shell, "rotate-[1.5deg] cursor-grabbing shadow-pop")}
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

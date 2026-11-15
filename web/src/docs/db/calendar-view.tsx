import { useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import {
  addMonths,
  dayOfMonth,
  daysBetween,
  daysFrom,
  isDay,
  monthStart,
  sameMonth,
  startOfWeek,
  weekday,
} from "@/lib/days";
import { monthAndYear, today, weekdayName } from "@/lib/time";
import { setRowProps } from "@/docs/actions";
import { createProperty, setViewConfig } from "@/docs/db/actions";
import type { ViewProps } from "@/docs/db/use-table";
import type { Doc } from "@/lib/types-docs";
import { Button, IconButton } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/** "Mon" … "Sun" in the person's language. 1 January 2024 was a Monday. */
const WEEKDAYS = daysFrom("2024-01-01", 7).map((day) => weekdayName(day));

function Chip({ row, onOpen, readOnly }: { row: Doc; onOpen: (id: string) => void; readOnly: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({ id: row.id, disabled: readOnly });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(row.id);
      }}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cx(
        "block w-full touch-manipulation truncate rounded-sm border border-line bg-surface px-1.5 py-0.5 text-left text-xs shadow-card hover:border-line-strong max-sm:px-1 max-sm:text-2xs",
        isDragging && "relative z-20 shadow-pop",
        !row.title && "text-ink-3",
      )}
    >
      {row.title || t("db.untitled")}
    </button>
  );
}

function DayCell({
  day,
  dim,
  isToday,
  rows,
  onOpen,
  onAdd,
  readOnly,
}: {
  day: string;
  dim: boolean;
  isToday: boolean;
  rows: Doc[];
  onOpen: (id: string) => void;
  onAdd: () => void;
  /** Rows open; a click on the day adds none, and nothing is dragged. */
  readOnly: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: day, disabled: readOnly });
  return (
    <div
      ref={setNodeRef}
      onClick={readOnly ? undefined : onAdd}
      className={cx(
        "group/day flex min-h-24 min-w-0 cursor-default flex-col gap-1 border-r border-b border-line p-1 max-sm:min-h-20 max-sm:p-0.5",
        dim && "bg-sunken/60",
        isOver && "bg-accent-soft",
      )}
    >
      <div className="flex h-5 items-center justify-between">
        <Plus
          className={cx("size-3.5 text-ink-3 opacity-0 max-sm:hidden", !readOnly && "group-hover/day:opacity-100")}
          aria-hidden
        />
        <span
          className={cx(
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tnum",
            isToday ? "bg-accent font-semibold text-accent-ink" : dim ? "text-ink-3" : "text-ink-2",
          )}
        >
          {dayOfMonth(day)}
        </span>
      </div>
      {rows.map((row) => (
        <Chip key={row.id} row={row} onOpen={onOpen} readOnly={readOnly} />
      ))}
    </div>
  );
}

/** Rows on a month grid by a date property. Click a day to add a row there; drag a row to another day. */
export function CalendarView({ db, view, rows, onOpen, onAdd, readOnly }: ViewProps) {
  const dates = db.table.props.filter((p) => p.type === "date");
  const dateProp = dates.find((p) => p.id === view.config?.date_prop) ?? dates[0];
  const [month, setMonth] = useState(() => monthStart(today()));
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const byDay = useMemo(() => {
    const out = new Map<string, Doc[]>();
    if (!dateProp) return out;
    for (const r of rows) {
      const day = r.props?.[dateProp.id];
      if (isDay(day)) out.set(day, [...(out.get(day) ?? []), r]);
    }
    return out;
  }, [rows, dateProp]);

  if (!dateProp) {
    const make = () =>
      setViewConfig(view, { date_prop: createProperty(db.table.doc.id, t("db.calendar.date"), "date") });
    return (
      <EmptyState
        icon={<CalendarDays />}
        title={t("db.calendar.needsDate")}
        hint={t("db.calendar.needsDateHint")}
        action={!readOnly && <Button onClick={make}>{t("db.calendar.addDate")}</Button>}
      />
    );
  }

  const first = startOfWeek(month);
  const next = addMonths(month, 1);
  const weeks = Math.ceil((weekday(month) + daysBetween(month, next)) / 7);
  const days = daysFrom(first, weeks * 7);
  const now = today();
  const undated = rows.length - [...byDay.values()].reduce((n, list) => n + list.length, 0);

  function drop(e: DragEndEvent) {
    if (!e.over || !dateProp) return;
    const row = rows.find((r) => r.id === e.active.id);
    if (row && row.props?.[dateProp.id] !== e.over.id) setRowProps(row.id, { [dateProp.id]: String(e.over.id) });
  }

  return (
    <div>
      <div className="flex h-9 items-center gap-1">
        <h3 className="flex-1 text-sm font-semibold">{monthAndYear(month)}</h3>
        {undated > 0 && <span className="mr-2 text-xs text-ink-3">{t("db.calendar.undated", { n: undated })}</span>}
        <Button variant="ghost" size="sm" onClick={() => setMonth(monthStart(today()))}>
          {t("db.calendar.today")}
        </Button>
        <IconButton size="sm" label={t("db.calendar.prev")} onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <IconButton size="sm" label={t("db.calendar.next")} onClick={() => setMonth(next)}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
      <DndContext sensors={sensors} onDragEnd={drop}>
        <div className="grid grid-cols-7 overflow-hidden rounded-lg border-t border-l border-line">
          {WEEKDAYS.map((name) => (
            <div
              key={name}
              className="border-r border-b border-line bg-sunken px-1.5 py-1 text-xs font-medium text-ink-3 max-sm:px-0.5 max-sm:text-center max-sm:text-2xs"
            >
              {name}
            </div>
          ))}
          {days.map((day) => (
            <DayCell
              key={day}
              day={day}
              dim={!sameMonth(day, month)}
              isToday={day === now}
              rows={byDay.get(day) ?? []}
              onOpen={onOpen}
              onAdd={() => onOpen(onAdd({ [dateProp.id]: day }))}
              readOnly={readOnly}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

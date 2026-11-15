import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChartGantt } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addDays, dayOfMonth, daysBetween, daysFrom, isDay, sameMonth, weekday } from "@/lib/days";
import { shortMonthAndYear, today } from "@/lib/time";
import { setRowProps } from "@/docs/actions";
import { createProperty, setViewConfig } from "@/docs/db/actions";
import type { ViewProps } from "@/docs/db/use-table";
import type { Doc } from "@/types/docs";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

const DAY_W = 30;
/** A bar of three days or fewer has no room for its title. */
const short = (span: Span) => !!span.start && !!span.end && daysBetween(span.start, span.end) < 3;
const MAX_DAYS = 550;

interface Span {
  row: Doc;
  start?: string;
  end?: string;
}

/**
 * Rows as bars on a scale of days, from a start date to an end date. Drag
 * a bar sideways to move it in time. Rows with no start date are listed
 * without a bar.
 */
export function TimelineView({ db, view, rows, onOpen, readOnly }: ViewProps) {
  const dates = db.table.props.filter((p) => p.type === "date");
  const startProp = dates.find((p) => p.id === view.config?.date_prop) ?? dates[0];
  const endProp =
    dates.find((p) => p.id === view.config?.end_prop) ?? dates.find((p) => p.id !== startProp?.id) ?? startProp;
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; days: number } | null>(null);
  const now = today();

  const spans = useMemo<Span[]>(
    () =>
      rows.map((row) => {
        const s = startProp ? row.props?.[startProp.id] : undefined;
        const e = endProp ? row.props?.[endProp.id] : undefined;
        if (!isDay(s)) return { row };
        return { row, start: s, end: isDay(e) && e >= s ? e : s };
      }),
    [rows, startProp, endProp],
  );

  const [from, total] = useMemo(() => {
    let lo = now;
    let hi = now;
    for (const s of spans) {
      if (s.start && s.start < lo) lo = s.start;
      if (s.end && s.end > hi) hi = s.end;
    }
    const first = addDays(lo, -4);
    return [first, Math.min(MAX_DAYS, Math.max(45, daysBetween(first, hi) + 12))] as const;
  }, [spans, now]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (daysBetween(from, now) - 3) * DAY_W);
  }, [from, now]);

  if (!startProp || !endProp) {
    const make = () => {
      const start = createProperty(db.table.doc.id, t("db.timeline.start"), "date");
      const end = createProperty(db.table.doc.id, t("db.timeline.end"), "date");
      setViewConfig(view, { date_prop: start, end_prop: end });
    };
    return (
      <EmptyState
        icon={<ChartGantt />}
        title={t("db.timeline.needsDates")}
        hint={t("db.timeline.needsDatesHint")}
        action={!readOnly && <Button onClick={make}>{t("db.timeline.addDates")}</Button>}
      />
    );
  }

  const days = daysFrom(from, total);
  const months: { day: string; days: number }[] = [];
  for (const day of days) {
    const last = months[months.length - 1];
    if (last && sameMonth(last.day, day)) last.days++;
    else months.push({ day, days: 1 });
  }
  const todayAt = daysBetween(from, now);

  function grab(e: ReactPointerEvent<HTMLButtonElement>, span: Span) {
    if (e.button !== 0 || !span.start || !span.end || !startProp || !endProp) return;
    const bar = e.currentTarget;
    const x0 = e.clientX;
    const { start, end, row } = span;
    let moved = 0;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      moved = Math.round((ev.clientX - x0) / DAY_W);
      setDrag(Math.abs(ev.clientX - x0) > 4 ? { id: row.id, days: moved } : null);
    };
    const up = (ev: PointerEvent) => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      setDrag(null);
      if (Math.abs(ev.clientX - x0) <= 4) onOpen(row.id);
      else if (moved !== 0) {
        const values: Record<string, unknown> = { [startProp.id]: addDays(start, moved) };
        if (endProp.id !== startProp.id && isDay(row.props?.[endProp.id])) values[endProp.id] = addDays(end, moved);
        setRowProps(row.id, values);
      }
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  }

  const label = "sticky left-0 z-10 flex w-44 shrink-0 items-center border-r border-line bg-surface px-2 max-sm:w-28";
  return (
    <div ref={scroller} className="overflow-x-auto rounded-lg border border-line">
      <div className="w-max min-w-full">
        <div className="flex h-12 border-b border-line bg-sunken">
          <div className={cx(label, "z-20 bg-sunken text-xs font-medium text-ink-3")}>{t("db.title")}</div>
          <div>
            <div className="flex h-6">
              {months.map((m) => (
                <div
                  key={m.day}
                  style={{ width: m.days * DAY_W }}
                  className="shrink-0 border-l border-line first:border-l-0"
                >
                  {/* The name follows the scroll until its month runs out. */}
                  <span className="sticky left-44 inline-block px-1.5 pt-1 text-xs font-medium whitespace-nowrap text-ink-2 max-sm:left-28">
                    {shortMonthAndYear(m.day)}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex h-6">
              {days.map((day) => (
                <div
                  key={day}
                  style={{ width: DAY_W }}
                  className={cx("flex shrink-0 items-center justify-center", weekday(day) > 4 && "bg-hover/50")}
                >
                  <span
                    className={cx(
                      "flex size-5 items-center justify-center rounded-full text-2xs tnum",
                      day === now ? "bg-accent font-semibold text-accent-ink" : "text-ink-3",
                    )}
                  >
                    {dayOfMonth(day)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {spans.map((span) => {
          const shift = drag?.id === span.row.id ? drag.days : 0;
          return (
            <div key={span.row.id} className="flex h-9 border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(span.row.id)}
                className={cx(label, "text-left text-sm hover:bg-hover")}
              >
                <span className={cx("truncate", !span.row.title && "text-ink-3")}>
                  {span.row.title || t("db.untitled")}
                </span>
              </button>
              <div className="relative" style={{ width: total * DAY_W }}>
                <span
                  className="absolute inset-y-0 w-px bg-accent/50"
                  style={{ left: todayAt * DAY_W + DAY_W / 2 }}
                  aria-hidden
                />
                {span.start && span.end ? (
                  <>
                    <button
                      type="button"
                      aria-label={span.row.title || t("db.untitled")}
                      onPointerDown={readOnly ? undefined : (e) => grab(e, span)}
                      onClick={readOnly ? () => onOpen(span.row.id) : undefined}
                      onKeyDown={(e) => e.key === "Enter" && onOpen(span.row.id)}
                      style={{
                        left: (daysBetween(from, span.start) + shift) * DAY_W + 2,
                        width: (daysBetween(span.start, span.end) + 1) * DAY_W - 4,
                      }}
                      className={cx(
                        "absolute top-1.5 flex h-6 touch-none items-center rounded-md border border-accent/30 bg-accent-soft px-1.5 text-xs font-medium text-accent-text hover:border-accent/60",
                        !readOnly && "cursor-grab",
                        shift !== 0 && "cursor-grabbing shadow-pop",
                      )}
                    >
                      {!short(span) && <span className="truncate">{span.row.title || t("db.untitled")}</span>}
                    </button>
                    {/* A bar too short for its name carries it alongside. */}
                    {short(span) && (
                      <span
                        className="pointer-events-none absolute top-1.5 flex h-6 items-center pl-1.5 text-xs whitespace-nowrap text-ink-2"
                        style={{ left: (daysBetween(from, span.end) + 1 + shift) * DAY_W }}
                      >
                        {span.row.title || t("db.untitled")}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="sticky left-48 inline-flex h-9 items-center text-xs text-ink-3 max-sm:left-32">
                    {t("db.timeline.noDates")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {spans.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-3">{t("db.empty")}</p>}
      </div>
    </div>
  );
}

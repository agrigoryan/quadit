// A cycle's burn-up: how much was planned (scope) and how much of it is
// done, day by day, on one axis. Days that have not come are left empty.
// The ends of both lines carry their numbers; the pointer or the arrow keys
// read any other day.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { formatDay } from "@/lib/time";
import { ChartTip, Legend, numberWidth, ticks, useWidth } from "@/insights/charts/base";
import { count } from "@/insights/lib/amounts";
import type { ChartDay } from "@/insights/lib/types";

const H = 200;
const TOP = 18;
const AXIS = 20;
const RIGHT = 14;

export interface BurnPoint {
  date: string;
  scope: number;
  done: number;
}

/** The days so far, in tasks or in points. */
function burnPoints(days: ChartDay[], unit: "tasks" | "points"): BurnPoint[] {
  return days
    .filter((d) => d.scope >= 0)
    .map((d) =>
      unit === "points"
        ? { date: d.date, scope: d.points, done: d.points_done }
        : { date: d.date, scope: d.scope, done: d.done },
    );
}

interface Props {
  days: ChartDay[];
  unit: "tasks" | "points";
  /** Today as YYYY-MM-DD, to mark it when it falls inside the cycle. */
  today: string;
}

export function BurnUp({ days, unit, today }: Props) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const points = burnPoints(days, unit);
  const marks = ticks(Math.max(1, ...points.map((p) => p.scope)), 4);
  const top = marks[marks.length - 1] ?? 1;
  // Room for the numbers on the axis: three digits, or as many as a big cycle has.
  const gutter = Math.max(26, 8 + numberWidth(count(top)));
  const plotW = Math.max(1, width - gutter - RIGHT);
  const plotH = H - TOP - AXIS;
  const n = Math.max(1, days.length - 1);
  const x = (i: number) => gutter + (i / n) * plotW;
  const y = (v: number) => TOP + plotH - (v / top) * plotH;
  const line = (pick: (p: BurnPoint) => number) =>
    points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
  const last = points.length - 1;
  const end = points[last];
  const todayAt = days.findIndex((d) => d.date === today);
  // A date under about every 70 pixels, always including the first and last day.
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 70))));
  const shown = at === null ? undefined : points[at];
  const scope = { name: t("cycle.chart.scope"), color: "var(--viz-started)" };
  const done = { name: t("cycle.chart.done"), color: "var(--viz-done)" };
  // Each line ends in its number: to the right of the last point while days are still to come, else above and
  // below it at the left. When the two lines meet the labels would collide, so one says both.
  const apart = end ? y(end.done) - y(end.scope) : 0;
  const roomRight = width - RIGHT - x(last) >= 72;
  const endAt = (py: number, beside: number, level: number) =>
    roomRight
      ? { x: x(last) + 10, y: py + level, textAnchor: "start" as const }
      : { x: x(last) - 8, y: py + beside, textAnchor: "end" as const };

  function move(e: React.PointerEvent) {
    const left = e.currentTarget.getBoundingClientRect().left;
    const i = Math.round(((e.clientX - left - gutter) / plotW) * n);
    setAt(points.length ? Math.min(last, Math.max(0, i)) : null);
  }
  function key(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const from = at ?? last;
    setAt(Math.min(last, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))));
  }

  return (
    <div>
      <Legend
        series={[
          { ...scope, mark: "line" },
          { ...done, mark: "line" },
        ]}
        className="mb-1"
      />
      <div
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={
          end
            ? t("cycle.chart.label", { scope: end.scope, done: end.done, day: formatDay(end.date) })
            : t("cycle.chart.notStarted")
        }
        className="relative rounded-sm outline-offset-2"
        onPointerMove={move}
        onPointerLeave={() => setAt(null)}
        onKeyDown={key}
        onFocus={() => points.length && setAt(last)}
        onBlur={() => setAt(null)}
      >
        {width > 0 && (
          <svg width={width} height={H} aria-hidden className="block">
            {marks.map((v) => (
              <g key={v}>
                <line
                  x1={gutter}
                  x2={width - RIGHT}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={v === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                  strokeWidth={1}
                />
                <text x={gutter - 6} y={y(v) + 3.5} textAnchor="end" className="fill-ink-3 text-[10px] tnum">
                  {count(v)}
                </text>
              </g>
            ))}
            {days.map(
              (d, i) =>
                (i % every === 0 || i === days.length - 1) &&
                (i === days.length - 1 || days.length - 1 - i >= every * 0.6) && (
                  <text
                    key={d.date}
                    x={x(i)}
                    y={H - 5}
                    textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
                    className="fill-ink-3 text-[10px] tnum"
                  >
                    {formatDay(d.date)}
                  </text>
                ),
            )}
            {todayAt >= 0 && (
              <g>
                <line x1={x(todayAt)} x2={x(todayAt)} y1={TOP - 6} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />
                <text
                  x={x(todayAt)}
                  y={TOP - 9}
                  textAnchor={todayAt > n * 0.85 ? "end" : "middle"}
                  className="fill-ink-2 text-[10px] font-medium"
                >
                  {t("cycle.chart.today")}
                </text>
              </g>
            )}
            {points.length > 0 && end && (
              <>
                <path
                  d={`${line((p) => p.done)}L${x(last)},${y(0)}L${x(0)},${y(0)}Z`}
                  fill="var(--viz-done)"
                  opacity={0.1}
                />
                <path
                  d={line((p) => p.scope)}
                  fill="none"
                  stroke="var(--viz-started)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={line((p) => p.done)}
                  fill="none"
                  stroke="var(--viz-done)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle
                  cx={x(last)}
                  cy={y(end.scope)}
                  r={5}
                  fill="var(--viz-started)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
                <circle
                  cx={x(last)}
                  cy={y(end.done)}
                  r={5}
                  fill="var(--viz-done)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
                {at === null &&
                  (Math.abs(apart) >= 14 ? (
                    <>
                      <text {...endAt(y(end.scope), -8, 4)} className="fill-ink text-[11px] font-medium tnum">
                        {t("cycle.chart.scopeEnd", { n: end.scope })}
                      </text>
                      <text {...endAt(y(end.done), 15, 4)} className="fill-ink text-[11px] font-medium tnum">
                        {t("cycle.chart.doneEnd", { n: end.done })}
                      </text>
                    </>
                  ) : (
                    <text {...endAt(y(end.scope), -8, 4)} className="fill-ink text-[11px] font-medium tnum">
                      {t("cycle.chart.bothEnd", { done: end.done, scope: end.scope })}
                    </text>
                  ))}
              </>
            )}
            {shown && at !== null && (
              <g>
                <line x1={x(at)} x2={x(at)} y1={TOP} y2={y(0)} stroke="var(--line-strong)" strokeWidth={1} />
                <circle
                  cx={x(at)}
                  cy={y(shown.scope)}
                  r={5}
                  fill="var(--viz-started)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
                <circle
                  cx={x(at)}
                  cy={y(shown.done)}
                  r={5}
                  fill="var(--viz-done)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
        )}
        {shown && at !== null && (
          <ChartTip
            x={x(at)}
            width={width}
            title={formatDay(shown.date)}
            rows={[
              { ...scope, value: count(shown.scope) },
              { ...done, value: count(shown.done) },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** The same numbers as rows, for the table view. */
export function burnRows(days: ChartDay[], unit: "tasks" | "points"): (string | number)[][] {
  return burnPoints(days, unit).map((p) => [formatDay(p.date), p.scope, p.done]);
}

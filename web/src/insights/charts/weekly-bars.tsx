// Tasks opened and closed per week, as pairs of thin columns on one axis.
// The newest week carries its numbers; the rest are read from the axis, the
// hover readout (also on keyboard focus) or the table.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { formatDay } from "@/lib/time";
import { ChartTip, Legend, numberWidth, ticks, useWidth } from "@/insights/charts/base";
import { addDays } from "@/lib/days";
import { count } from "@/insights/lib/amounts";
import type { WeekCount } from "@/insights/lib/types";

const H = 132;
const TOP = 14;
const AXIS = 18;
const BAR = 9;
/** The room between the two numbers of the newest week, and how far apart in height they must be to share a place. */
const GAP = 5;
const LINE = 14;

const opened = () => ({ name: t("ins.chart.opened"), color: "var(--viz-started)" });
const closed = () => ({ name: t("ins.chart.closed"), color: "var(--viz-done)" });

/** A column with a rounded top and a square foot on the baseline. */
function column(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function WeeklyBars({ weeks }: { weeks: WeekCount[] }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.opened, w.closed)));
  const marks = ticks(max);
  const top = marks[marks.length - 1] ?? 1;
  // Room for the numbers on the axis: two digits, or as many as a busy week has.
  const left = Math.max(22, 10 + numberWidth(count(top)));
  const last = weeks.length - 1;
  const newest = weeks[last];
  const numbered = !!newest && (newest.opened > 0 || newest.closed > 0);
  const plotH = H - TOP - AXIS;
  const y = (v: number) => TOP + plotH - (v / top) * plotH;

  /** The columns when `room` is kept free on the right, and where the newest week's two numbers then go. */
  function layout(room: number) {
    const plotW = Math.max(0, width - left - room);
    const band = weeks.length ? plotW / weeks.length : 0;
    const bar = Math.max(3, Math.min(BAR, (band - 8) / 2));
    const cx = left + band * last + band / 2;
    const texts = [count(newest?.opened ?? 0), count(newest?.closed ?? 0)] as const;
    const wide = [numberWidth(texts[0]), numberWidth(texts[1])] as const;
    const tops = [y(newest?.opened ?? 0) - 4, y(newest?.closed ?? 0) - 4] as const;
    // Opened sits over its own column, but stays out of the week before; over a taller Closed column it is lifted clear.
    const openedEnd = Math.max(cx - band / 2, cx - 1 - bar / 2 - wide[0] / 2) + wide[0];
    const openedY = openedEnd > cx - 1 ? Math.min(tops[0], tops[1]) : tops[0];
    // Closed starts over its own column, or after Opened when the two are at one height.
    const beside = Math.abs(openedY - tops[1]) < LINE;
    const closedEnd = Math.max(cx + GAP / 2, beside ? openedEnd + GAP : 0) + wide[1];
    // Text is anchored at its right edge, so it cannot pass the edge of the chart.
    const edge = Math.min(width, closedEnd);
    return {
      band,
      bar,
      short: numbered ? Math.max(0, closedEnd - width) : 0,
      numbers: [
        { text: texts[0], x: beside ? Math.min(openedEnd, edge - wide[1] - GAP) : openedEnd, y: openedY },
        { text: texts[1], x: edge, y: tops[1] },
      ],
    };
  }
  // On a narrow chart the columns stop short of the right edge, by as much as the numbers need. The room and the
  // width of a column depend on each other; a few rounds settle them.
  let room = 0;
  let fit = layout(room);
  for (let round = 0; round < 3 && fit.short > 0; round++) fit = layout((room += fit.short));
  const { band, bar } = fit;
  // Dates under every second or third week, so they never touch.
  const every = band >= 44 ? 1 : band >= 24 ? 2 : 3;
  const hovered = at === null ? undefined : weeks[at];
  const centre = (i: number) => left + band * i + band / 2;

  return (
    <div>
      <Legend
        series={[
          { ...opened(), mark: "bar" },
          { ...closed(), mark: "bar" },
        ]}
        className="mb-1"
      />
      <div ref={box} className="relative" onPointerLeave={() => setAt(null)}>
        {width > 0 && (
          <svg
            width={width}
            height={H}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a chart's parts, not form fields: <fieldset> is for those
            role="group"
            aria-label={t("ins.chart.weeklyLabel", { n: weeks.length })}
            className="block"
          >
            {marks.map((v) => (
              <g key={v}>
                <line
                  x1={left}
                  x2={width}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={v === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                  strokeWidth={1}
                />
                <text x={left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-ink-3 text-[10px] tnum">
                  {count(v)}
                </text>
              </g>
            ))}
            {weeks.map((w, i) => {
              const cx = centre(i);
              const label = t("ins.chart.weekTip", { day: formatDay(w.week), opened: w.opened, closed: w.closed });
              return (
                <g
                  key={w.week}
                  tabIndex={0}
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a bar of the chart, drawn in SVG, named for a screen reader
                  role="img"
                  aria-label={label}
                  onPointerEnter={() => setAt(i)}
                  onFocus={() => setAt(i)}
                  onBlur={() => setAt(null)}
                  className="outline-none [&:focus-visible>rect]:stroke-accent"
                >
                  <rect
                    x={left + band * i}
                    y={0}
                    width={band}
                    height={H - AXIS}
                    fill={at === i ? "var(--hover)" : "transparent"}
                    strokeWidth={1.5}
                    rx={3}
                  />
                  <path d={column(cx - bar - 1, y(w.opened), bar, y(0) - y(w.opened))} fill="var(--viz-started)" />
                  <path d={column(cx + 1, y(w.closed), bar, y(0) - y(w.closed))} fill="var(--viz-done)" />
                  {i === last &&
                    numbered &&
                    at === null &&
                    fit.numbers.map((n, side) => (
                      <text
                        key={side}
                        x={n.x}
                        y={n.y}
                        textAnchor="end"
                        className="fill-ink text-[10px] font-medium tnum"
                      >
                        {n.text}
                      </text>
                    ))}
                  {(last - i) % every === 0 &&
                    (i === last ? (
                      // The newest date ends where the chart does when its week is too narrow to hold it.
                      <text
                        x={Math.min(width, cx + formatDay(w.week).length * 3)}
                        y={H - 4}
                        textAnchor="end"
                        className="fill-ink-3 text-[10px] tnum"
                      >
                        {formatDay(w.week)}
                      </text>
                    ) : (
                      <text x={cx} y={H - 4} textAnchor="middle" className="fill-ink-3 text-[10px] tnum">
                        {formatDay(w.week)}
                      </text>
                    ))}
                </g>
              );
            })}
          </svg>
        )}
        {hovered && at !== null && (
          <ChartTip
            x={centre(at)}
            width={width}
            title={t("ins.chart.weekOf", { from: formatDay(hovered.week), to: formatDay(addDays(hovered.week, 6)) })}
            rows={[
              { ...opened(), value: count(hovered.opened) },
              { ...closed(), value: count(hovered.closed) },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** The same numbers as rows, for the table view. */
export function weeklyRows(weeks: WeekCount[]): (string | number)[][] {
  return weeks.map((w) => [
    t("ins.chart.weekOf", { from: formatDay(w.week), to: formatDay(addDays(w.week, 6)) }),
    w.opened,
    w.closed,
  ]);
}

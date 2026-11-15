// Tasks opened and closed per week, as pairs of thin columns on one axis.
// The newest week carries its numbers; the rest are read from the axis, the
// hover readout (also on keyboard focus) or the table.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { formatDay } from "@/lib/time";
import { ChartTip, Legend, ticks, useWidth } from "@/insights/charts/base";
import { addDays } from "@/insights/lib/format";
import type { WeekCount } from "@/insights/lib/types";

const H = 132;
const TOP = 14;
const AXIS = 18;
const BAR = 9;

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
  const left = Math.max(22, 10 + String(top).length * 6);
  const plotW = Math.max(0, width - left);
  const band = weeks.length ? plotW / weeks.length : 0;
  const plotH = H - TOP - AXIS;
  const y = (v: number) => TOP + plotH - (v / top) * plotH;
  const bar = Math.max(3, Math.min(BAR, (band - 8) / 2));
  // Dates under every second or third week, so they never touch.
  const every = band >= 44 ? 1 : band >= 24 ? 2 : 3;
  const last = weeks.length - 1;
  const hovered = at === null ? undefined : weeks[at];

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
          <svg width={width} height={H} role="group" aria-label={t("ins.chart.weeklyLabel", { n: weeks.length })} className="block">
            {marks.map((v) => (
              <g key={v}>
                <line x1={left} x2={width} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} />
                <text x={left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-ink-3 text-[10px] tnum">
                  {v}
                </text>
              </g>
            ))}
            {weeks.map((w, i) => {
              const cx = left + band * i + band / 2;
              const label = t("ins.chart.weekTip", { day: formatDay(w.week), opened: w.opened, closed: w.closed });
              return (
                <g
                  key={w.week}
                  tabIndex={0}
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
                  {i === last && (w.opened > 0 || w.closed > 0) && at === null && (
                    <>
                      <text x={cx - 1 - bar / 2} y={y(w.opened) - 4} textAnchor="middle" className="fill-ink text-[10px] font-medium tnum">
                        {w.opened}
                      </text>
                      <text x={cx + 1 + bar / 2} y={y(w.closed) - 4} textAnchor="middle" className="fill-ink text-[10px] font-medium tnum">
                        {w.closed}
                      </text>
                    </>
                  )}
                  {(last - i) % every === 0 && (
                    <text x={cx} y={H - 4} textAnchor="middle" className="fill-ink-3 text-[10px] tnum">
                      {formatDay(w.week)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hovered && at !== null && (
          <ChartTip
            x={left + band * at + band / 2}
            width={width}
            title={t("ins.chart.weekOf", { from: formatDay(hovered.week), to: formatDay(addDays(hovered.week, 6)) })}
            rows={[
              { ...opened(), value: hovered.opened },
              { ...closed(), value: hovered.closed },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** The same numbers as rows, for the table view. */
export function weeklyRows(weeks: WeekCount[]): (string | number)[][] {
  return weeks.map((w) => [t("ins.chart.weekOf", { from: formatDay(w.week), to: formatDay(addDays(w.week, 6)) }), w.opened, w.closed]);
}

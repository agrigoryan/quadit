// What every chart here is built from: a measured width (so text is never
// scaled), round axis ticks, a legend, the hover readout and the switch to
// a plain table of the same numbers.

import "@/insights/viz.css";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { ChartNoAxesColumn, Table2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { IconButton } from "@/ui/button";

/** The width of an element in CSS pixels, followed as it changes. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

/** Round values for an axis from 0 to at least `max`: 0, 5, 10 rather than 0, 4.5, 9. */
export function ticks(max: number, count = 3): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow);
  const out: number[] = [];
  for (let v = 0; v < max + step; v += step) out.push(v);
  return out;
}

export interface Series {
  name: string;
  color: string;
  /** How the series is drawn, so its key looks like its mark. */
  mark?: "bar" | "line";
}

/** The key of a chart: one swatch and name per series, in the order they are drawn. */
export function Legend({ series, className }: { series: (Series & { value?: ReactNode })[]; className?: string }) {
  return (
    <ul className={cx("flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2", className)}>
      {series.map((s) => (
        <li key={s.name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={s.mark === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]"}
            style={{ background: s.color }}
          />
          {s.name}
          {s.value !== undefined && <span className="text-ink tnum">{s.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface TipRow {
  name: string;
  color?: string;
  value: ReactNode;
}

interface TipProps {
  /** Where the readout points, in pixels from the chart's left edge. */
  x: number;
  /** The chart's width, to keep the readout inside it. */
  width: number;
  title: string;
  rows: TipRow[];
}

/** The readout shown on hover and on keyboard focus: the value first, then what it is. */
export function ChartTip({ x, width, title, rows }: TipProps) {
  const half = 80;
  const left = Math.min(Math.max(x, half), Math.max(half, width - half));
  return (
    <div
      role="status"
      className="pointer-events-none absolute -top-12 z-10 w-40 -translate-x-1/2 rounded-sm bg-inverse px-2 py-1.5 text-xs text-inverse-ink shadow-pop"
      style={{ left }}
    >
      <p className="mb-0.5 opacity-70">{title}</p>
      {rows.map((row) => (
        <p key={row.name} className="flex items-center gap-1.5">
          {row.color && <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />}
          <span className="font-semibold tnum">{row.value}</span>
          <span className="truncate opacity-80">{row.name}</span>
        </p>
      ))}
    </div>
  );
}

/** The button that swaps a chart for a table of its numbers, and back. */
export function TableSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <IconButton label={on ? t("ins.chart.showChart") : t("ins.chart.showTable")} size="sm" aria-pressed={on} onClick={() => onChange(!on)}>
      {on ? <ChartNoAxesColumn className="size-3.5" /> : <Table2 className="size-3.5" />}
    </IconButton>
  );
}

interface TableProps {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}

/** A chart's numbers as a table: the first column names the row, the rest are amounts. */
export function DataTable({ caption, head, rows }: TableProps) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cx("border-b border-line py-1 font-medium text-ink-3", i === 0 ? "text-left" : "pl-3 text-right")}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row[0])}>
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="border-b border-line/70 py-1 text-left font-normal text-ink-2">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="border-b border-line/70 py-1 pl-3 text-right tnum">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

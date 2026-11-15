// The time scale across the top of the timeline (months over days or weeks)
// and the ruled background behind the rows: week lines, shaded weekends,
// month lines and the line for today.

import "@/insights/viz.css";
import { useMemo } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { monthAndYear, shortMonthAndTwoDigitYear } from "@/lib/time";
import { dateOf, isWeekend, monthsOf, type Scale, weeksOf, widthOf, xOf } from "@/insights/timeline/scale";

/** Months on the first line; under them every day (weeks zoom) or every Monday (months zoom). */
export function ScaleHeader({ scale, today }: { scale: Scale; today: number }) {
  const months = useMemo(() => monthsOf(scale), [scale]);
  const weeks = useMemo(() => weeksOf(scale), [scale]);
  const days = useMemo(() => {
    if (scale.zoom !== "weeks") return [];
    const out: number[] = [];
    for (let d = scale.start; d <= scale.end; d++) out.push(d);
    return out;
  }, [scale]);

  return (
    <div className="relative h-full text-2xs text-ink-3 select-none" style={{ width: widthOf(scale) }} aria-hidden>
      <div className="flex h-5.5">
        {months.map((m) => {
          const narrow = m.days * scale.dayW < 96;
          return (
            <div
              key={m.month}
              className="shrink-0 border-l border-line-strong first:border-l-0"
              style={{ width: m.days * scale.dayW }}
            >
              {m.days * scale.dayW >= 44 && (
                <span className="sticky left-[calc(var(--tl-left)+0.5rem)] inline-block px-2 pt-1 text-xs font-medium whitespace-nowrap text-ink-2">
                  {(narrow ? shortMonthAndTwoDigitYear : monthAndYear)(`${m.month}-01`)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="relative h-5.5">
        {scale.zoom === "weeks"
          ? days.map((d) => (
              <span
                key={d}
                className={cx(
                  "absolute top-0 flex h-5 items-center justify-center tnum",
                  d === today
                    ? "rounded-sm bg-accent font-semibold text-accent-ink"
                    : isWeekend(d)
                      ? "text-ink-3/70"
                      : "text-ink-2",
                )}
                style={{ left: xOf(scale, d) + 1, width: scale.dayW - 2 }}
              >
                {dateOf(d)}
              </span>
            ))
          : weeks.map((d) => (
              <span
                key={d}
                className="absolute top-0 flex h-5 items-center pl-1.5 tnum text-ink-2"
                style={{ left: xOf(scale, d) }}
              >
                {dateOf(d)}
              </span>
            ))}
        {scale.zoom === "months" && (
          <span
            className="absolute top-0 flex h-5 -translate-x-1/2 items-center rounded-sm bg-accent px-1.5 font-semibold text-accent-ink"
            style={{ left: xOf(scale, today) + scale.dayW / 2 }}
          >
            {t("timeline.today")}
          </span>
        )}
      </div>
    </div>
  );
}

/** The rules behind every row. It sits under the bars and takes no clicks. */
export function Backdrop({ scale, today }: { scale: Scale; today: number }) {
  const months = useMemo(() => monthsOf(scale), [scale]);
  const week = 7 * scale.dayW;
  // The scale starts on a Monday, so one repeating picture rules every week and shades its last two days.
  const rules = `linear-gradient(to right, var(--viz-grid) 1px, transparent 1px), linear-gradient(to right, transparent ${5 * scale.dayW}px, color-mix(in srgb, var(--sunken) 55%, transparent) ${5 * scale.dayW}px)`;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-[var(--tl-left)]"
      style={{ width: widthOf(scale), backgroundImage: rules, backgroundSize: `${week}px 100%` }}
    >
      {months.slice(1).map((m) => (
        <span
          key={m.month}
          className="absolute inset-y-0 w-px"
          style={{ left: xOf(scale, m.from), background: "var(--viz-axis)" }}
        />
      ))}
      <span
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent"
        style={{ left: xOf(scale, today) + scale.dayW / 2 }}
      />
    </div>
  );
}

// One bar on the timeline, and how its dates are changed: drag an end to
// change one date or the middle to move both, snapping to whole days; or
// focus it and use the arrow keys. While a change is under way the bar
// shows it and writes the dates beside itself; the change is sent once, when
// the pointer or the key is let go.

import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { formatDay } from "@/lib/time";
import { dayFromNumber } from "@/lib/days";
import { type Scale, xOf } from "@/insights/timeline/scale";

type Mode = "move" | "start" | "end";
type Range = { s: number; e: number };
/** A change under way: the dates as they stand, and which of them it has touched. */
type Gesture = { range: Range; start: boolean; end: boolean };

/** How long a bar with only one date is drawn, fading out towards the date it lacks. */
const OPEN_DAYS = 14;
/** A held arrow key is sent this long after the last step, if the key-up never comes. */
const SETTLE_MS = 700;

interface Props {
  /** What the bar is, for screen readers: "Boss fight, epic". */
  name: string;
  scale: Scale;
  /** Day numbers; leave one out when that date is not set. */
  start?: number;
  end?: number;
  /** Which dates may change: both (an epic), or only the end (a task's due date). */
  edit: "both" | "end";
  color: string;
  /** The share of the bar to fill solid, 0 to 1. Leave out for a solid bar. */
  share?: number;
  tall?: boolean;
  /** The end date has passed and the work is not done. */
  late?: boolean;
  /** The id of the element that explains the keys. */
  describedBy?: string;
  /** Written after the bar when nothing is being changed: usually the end date. */
  label?: ReactNode;
  onChange: (next: { start?: number; end?: number }) => void;
  /** Shown, not changed: the member may not change it. */
  readOnly?: boolean;
}

const day = (n: number) => formatDay(dayFromNumber(n));

function apply(mode: Mode, from: Range, by: number): Range {
  if (mode === "start") return { s: Math.min(from.s + by, from.e), e: from.e };
  if (mode === "end") return { s: from.s, e: Math.max(from.e + by, from.s) };
  return { s: from.s + by, e: from.e + by };
}

export function Bar({
  name,
  scale,
  start,
  end,
  edit,
  color,
  share,
  tall,
  late,
  describedBy,
  label,
  onChange,
  readOnly,
}: Props) {
  const hasStart = start !== undefined;
  const hasEnd = end !== undefined;
  const base: Range = { s: start ?? (end ?? 0) - OPEN_DAYS + 1, e: end ?? (start ?? 0) + OPEN_DAYS - 1 };
  const [draft, setDraft] = useState<Gesture | null>(null);
  // The gesture under way, also kept outside state so handlers always see the latest.
  const live = useRef<Gesture | null>(null);
  const drag = useRef<{ mode: Mode; x: number; from: Range } | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = draft?.range ?? base;

  useEffect(() => () => clearTimeout(settle.current), []);

  /** A task has one date to change, so every gesture on it changes that one. */
  const modeFor = (mode: Mode): Mode => (edit === "end" ? "end" : mode);

  function step(mode: Mode, range: Range) {
    const was = live.current;
    live.current = {
      range,
      // Moving a bar that has one date moves that date; it does not invent the other.
      start: (was?.start ?? false) || mode === "start" || (mode === "move" && hasStart),
      end: (was?.end ?? false) || mode === "end" || (mode === "move" && hasEnd),
    };
    setDraft(live.current);
  }

  function finish(commit: boolean) {
    clearTimeout(settle.current);
    const done = live.current;
    live.current = null;
    drag.current = null;
    setDraft(null);
    if (!commit || !done) return;
    const next: { start?: number; end?: number } = {};
    if (done.start && edit === "both" && done.range.s !== start) next.start = done.range.s;
    if (done.end && done.range.e !== end) next.end = done.range.e;
    if (next.start !== undefined || next.end !== undefined) onChange(next);
  }

  function down(e: PointerEvent, asked: Mode) {
    // A finger on the middle of a bar scrolls the timeline; only the ends drag.
    if (readOnly || e.button !== 0 || (e.pointerType === "touch" && asked === "move")) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone: the drag ends with the next event.
    }
    (e.currentTarget.closest("[data-bar]")?.querySelector("[role=slider]") as HTMLElement | null)?.focus({
      preventScroll: true,
    });
    drag.current = { mode: modeFor(asked), x: e.clientX, from: base };
  }

  function move(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const by = Math.round((e.clientX - d.x) / scale.dayW);
    // Nothing is touched until the pointer has gone a day's width: a click changes nothing.
    if (by === 0 && !live.current) return;
    step(d.mode, apply(d.mode, d.from, by));
  }

  function key(e: KeyboardEvent) {
    if (readOnly) return;
    if (e.key === "Escape" && live.current) {
      e.stopPropagation();
      finish(false);
      return;
    }
    const by =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "PageUp" ? -7 : e.key === "PageDown" ? 7 : 0;
    if (by === 0 || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const mode = modeFor(e.shiftKey ? (e.altKey ? "start" : "end") : "move");
    step(mode, apply(mode, live.current?.range ?? base, by));
    clearTimeout(settle.current);
    settle.current = setTimeout(() => finish(true), SETTLE_MS);
  }

  const changing = draft !== null;
  // A date that is not set yet counts once the gesture has reached for it.
  const startSet = hasStart || !!draft?.start;
  const endSet = hasEnd || !!draft?.end;
  const text =
    edit === "end"
      ? t("timeline.due", { day: day(shown.e) })
      : startSet && endSet
        ? t("timeline.range", { from: day(shown.s), to: day(shown.e) })
        : startSet
          ? t("timeline.from", { day: day(shown.s) })
          : t("timeline.until", { day: day(shown.e) });
  const fade = !endSet
    ? "linear-gradient(to right, #000 35%, transparent)"
    : !startSet
      ? "linear-gradient(to left, #000 35%, transparent)"
      : undefined;
  const handle =
    "absolute -inset-y-2 z-[1] w-3 cursor-ew-resize touch-none [@media(pointer:coarse)]:w-6 after:absolute after:inset-y-2 after:w-0.5 after:rounded-full after:bg-ink/0 hover:after:bg-ink/60";
  const handlers = { onPointerMove: move, onPointerUp: () => finish(true), onPointerCancel: () => finish(false) };

  return (
    <div
      data-bar
      className={cx("group/bar absolute top-1/2 -translate-y-1/2", tall ? "h-4" : "h-2.5", changing && "z-[2]")}
      style={{ left: xOf(scale, shown.s), width: (shown.e - shown.s + 1) * scale.dayW }}
    >
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the bar itself is dragged to change its dates, with its own keys; an <input type=range> cannot be
        role="slider"
        tabIndex={0}
        aria-label={name}
        aria-orientation="horizontal"
        aria-valuemin={scale.start}
        aria-valuemax={scale.end}
        aria-valuenow={shown.e}
        aria-valuetext={text}
        aria-readonly={readOnly || undefined}
        aria-describedby={describedBy}
        title={text}
        onKeyDown={key}
        onKeyUp={(e) => e.key.startsWith("Arrow") && live.current && !drag.current && finish(true)}
        onBlur={() => live.current && !drag.current && finish(true)}
        onPointerDown={(e) => down(e, "move")}
        {...handlers}
        className={cx(
          "absolute inset-0 overflow-hidden rounded-[4px] outline-offset-2",
          readOnly ? "" : edit === "both" ? "cursor-grab active:cursor-grabbing" : "cursor-ew-resize",
          changing && "ring-2 ring-accent/40",
        )}
        style={{
          background: share === undefined ? color : `color-mix(in srgb, ${color} 34%, var(--surface))`,
          maskImage: fade,
          WebkitMaskImage: fade,
          boxShadow: late ? "inset -3px 0 0 var(--viz-over)" : undefined,
        }}
      >
        {share !== undefined && share > 0 && (
          <div className="h-full" style={{ width: `${Math.min(1, share) * 100}%`, background: color }} />
        )}
      </div>
      {!readOnly && edit === "both" && (
        <span
          aria-hidden
          className={cx(handle, "-left-2 after:left-2")}
          onPointerDown={(e) => down(e, "start")}
          {...handlers}
        />
      )}
      {!readOnly && (
        <span
          aria-hidden
          className={cx(handle, "-right-2 after:right-2")}
          onPointerDown={(e) => down(e, "end")}
          {...handlers}
        />
      )}
      <span
        className={cx(
          "pointer-events-none absolute top-1/2 left-full ml-2.5 -translate-y-1/2 text-2xs whitespace-nowrap tnum",
          changing
            ? "rounded-xs bg-inverse px-1.5 py-0.5 font-medium text-inverse-ink"
            : late
              ? "text-danger"
              : "text-ink-3",
        )}
      >
        {changing ? text : label}
      </span>
    </div>
  );
}

// One of several things shown in a box, with the way to the others: round
// arrows at the box's sides, the position "2 / 3", and the left and right
// arrow keys. The files lightbox, an option's pictures on its card and in
// the compare view, and the compare view's walk through every picture all
// use it, so they look and move alike. Place the pieces in a positioned box.

import type { KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Tooltip } from "@/ui/tooltip";

/** Where a carousel is, and how it moves. */
export interface Steps {
  /** The one shown, from 0. */
  index: number;
  total: number;
  /** Asked to show another. */
  onShow: (index: number) => void;
  /**
   * Go round from the last to the first, as a set of pictures does. Without
   * it the ends stop, as numbered choices do.
   */
  wrap: boolean;
}

/** Compact over a card's picture; large on a stage over the whole screen. */
export type CarouselSize = "compact" | "large";

/** The one `by` away from `index`, brought round when the carousel wraps; null past an end. */
export function stepped({ index, total, wrap }: Omit<Steps, "onShow">, by: number): number | null {
  const next = index + by;
  if (wrap) return total > 0 ? (next + total) % total : null;
  return next >= 0 && next < total ? next : null;
}

/** Shows the one `by` away, if there is one. */
export function step(steps: Steps, by: number) {
  const to = stepped(steps, by);
  if (to !== null && to !== steps.index) steps.onShow(to);
}

/**
 * The left and right arrow keys, for the onKeyDown of the box the carousel
 * is in. A video, a field or a slider keeps the keys it has, and so does a
 * key held with a modifier. Says whether it moved.
 */
export function onCarouselKey(e: KeyboardEvent, steps: Steps): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  const target = e.target;
  if (target instanceof HTMLVideoElement || target instanceof HTMLInputElement) return false;
  if (target instanceof HTMLElement && target.getAttribute("role") === "slider") return false;
  e.preventDefault();
  step(steps, e.key === "ArrowLeft" ? -1 : 1);
  return true;
}

// Dark with a light edge, so they read on a light picture as on the black stage.
const round =
  "absolute top-1/2 z-[2] flex -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75 focus-visible:outline-white aria-disabled:cursor-default aria-disabled:opacity-30 aria-disabled:hover:bg-black/55";

const arrowSize: Record<CarouselSize, { button: string; icon: string; left: string; right: string }> = {
  compact: { button: "size-7 max-sm:size-9", icon: "size-4", left: "left-1.5", right: "right-1.5" },
  large: { button: "size-10", icon: "size-5", left: "left-3", right: "right-3" },
};

interface ArrowsProps extends Steps {
  size: CarouselSize;
  /** The arrows' names; "Previous" and "Next" when not given. */
  labels?: { previous: string; next: string };
  /** The keys that do the same, shown in the tooltips. */
  keys?: { previous: string; next: string };
}

/**
 * The previous and next arrows at the sides of the box. Nothing when there
 * is only one. At an end that does not wrap an arrow is marked, not
 * disabled: a disabled button would drop the focus, and the keys with it.
 */
export function CarouselArrows({ size, labels, keys, ...steps }: ArrowsProps) {
  if (steps.total < 2) return null;
  const look = arrowSize[size];
  const arrow = (by: -1 | 1) => {
    const label = by < 0 ? (labels?.previous ?? t("common.previous")) : (labels?.next ?? t("common.next"));
    const end = stepped(steps, by) === null;
    const Icon = by < 0 ? ChevronLeft : ChevronRight;
    return (
      <Tooltip label={label} hint={by < 0 ? keys?.previous : keys?.next}>
        <button
          type="button"
          aria-label={label}
          aria-disabled={end || undefined}
          onClick={() => step(steps, by)}
          className={cx(round, look.button, by < 0 ? look.left : look.right)}
        >
          <Icon className={look.icon} aria-hidden />
        </button>
      </Tooltip>
    );
  };
  return (
    <>
      {arrow(-1)}
      {arrow(1)}
    </>
  );
}

const countSize: Record<CarouselSize, string> = {
  // At the top of a card's picture: the bottom has a video's controls and a pair's names.
  compact: "top-1.5 px-2 py-0.5 text-2xs",
  large: "bottom-3 px-2.5 py-1 text-xs",
};

/** "2 / 3", in the middle of the box's top (compact) or bottom (large). Nothing when there is only one. */
export function CarouselCount({ index, total, size }: { index: number; total: number; size: CarouselSize }) {
  if (total < 2) return null;
  return (
    <span
      aria-live="polite"
      className={cx(
        "pointer-events-none absolute left-1/2 z-[2] -translate-x-1/2 rounded-full bg-black/55 font-medium text-white tnum",
        countSize[size],
      )}
    >
      {t("common.position", { n: index + 1, total })}
    </span>
  );
}

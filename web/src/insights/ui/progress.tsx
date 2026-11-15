// Progress as one thin bar split into parts: done, under way, and the rest.
// The numbers are always written next to it; the bar is the picture of them.

import "@/insights/viz.css";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { count } from "@/insights/lib/amounts";

interface Props {
  done: number;
  started?: number;
  total: number;
  className?: string;
  /** 4px instead of 8px, for dense rows. */
  thin?: boolean;
}

/** done / started / the rest, as shares of the whole. */
export function Progress({ done, started = 0, total, className, thin }: Props) {
  const share = (n: number) => (total > 0 ? `${(Math.max(0, n) / total) * 100}%` : "0%");
  const label =
    started > 0 ? t("ins.progress.withStarted", { done, started, total }) : t("ins.progress", { done, total });
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a picture drawn with CSS or SVG, not an image file
      role="img"
      aria-label={label}
      title={label}
      className={cx(
        "flex gap-0.5 overflow-hidden rounded-full bg-sunken dark:bg-press",
        thin ? "h-1" : "h-2",
        className,
      )}
    >
      {done > 0 && (
        <span className="h-full rounded-full" style={{ width: share(done), background: "var(--viz-done)" }} />
      )}
      {started > 0 && (
        <span className="h-full rounded-full" style={{ width: share(started), background: "var(--viz-started)" }} />
      )}
    </span>
  );
}

/** "3/7" beside a bar: the usual pairing in a row. */
export function ProgressCount({ done, started, total, className }: Props) {
  return (
    <span className={cx("flex shrink-0 items-center gap-2", className)}>
      <span className="min-w-9 text-right text-xs text-ink-3 tnum" aria-hidden>
        {count(done)}/{count(total)}
      </span>
      <Progress done={done} started={started} total={total} thin className="w-20 max-sm:w-12" />
    </span>
  );
}

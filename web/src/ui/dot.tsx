// A small round dot in a row's colour.

import { cx } from "@/lib/cx";

/** A small round dot of a row's colour. */
export function Dot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      className={cx("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ background: color || "var(--ink-3)" }}
      aria-hidden
    />
  );
}

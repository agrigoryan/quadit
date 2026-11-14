import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** A key cap. Pass several keys as "⌘ K": each word gets its own cap. */
export function Kbd({ children, onDark = false }: { children: ReactNode; onDark?: boolean }) {
  const keys = typeof children === "string" ? children.split(" ") : [children];
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, i) => (
        <kbd
          key={i}
          className={cx(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs px-1 font-sans text-2xs font-medium",
            onDark ? "bg-white/15 text-inverse-ink" : "border border-line bg-sunken text-ink-2",
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

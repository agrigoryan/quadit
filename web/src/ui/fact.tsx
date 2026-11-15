// A fact with its name in front, as settings rows show them.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** A fact with its name in front: "Last used 3h". */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-baseline gap-1 whitespace-nowrap", className)}>
      <span className="text-ink-3">{label}</span>
      <span className="text-ink-2">{children}</span>
    </span>
  );
}

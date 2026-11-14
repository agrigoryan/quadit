// The frame every part of the task panel shares: a thin rule, a small
// heading, and room for one action at the right.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

interface Props {
  title: string;
  /** Shown faintly after the title: a count, a progress line. */
  meta?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Section({ title, meta, action, children, className }: Props) {
  return (
    <section aria-label={title} className={cx("border-t border-line px-4 py-3 md:px-6", className)}>
      <div className="flex h-7 items-center gap-2">
        <h3 className="text-xs font-medium text-ink-2">{title}</h3>
        {meta}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

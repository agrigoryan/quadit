// The frame of one panel on the dashboard and of one block on the other
// insight pages: a small heading, an optional count and action, the content.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { count } from "@/lib/amounts";

interface Props {
  title: string;
  /** Shown after the title: a count, a short qualifier. */
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No padding around the content: for lists whose rows run edge to edge. */
  flush?: boolean;
}

export function Panel({ title, meta, action, children, className, flush }: Props) {
  return (
    <section aria-label={title} className={cx("flex min-w-0 flex-col bg-surface", className)}>
      <header className="flex min-h-10 items-center gap-2 px-4 pt-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {meta}
        <span className="flex-1" />
        {action}
      </header>
      <div className={cx("min-w-0 flex-1", flush ? "pb-2" : "px-4 pb-4")}>{children}</div>
    </section>
  );
}

/** A quiet line for a panel with nothing to show. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-1 text-sm text-ink-2">{children}</p>;
}

/** The bar across the top of an insight page: what it is, then its controls. */
export function PageBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header
      className={cx(
        "flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 pr-2 pl-4",
        className,
      )}
    >
      {children}
    </header>
  );
}

/** A count in the highlighter: only for what waits on the person looking. */
export function MoveCount({ n }: { n: number }) {
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-sm bg-move px-1.5 text-xs font-semibold text-move-ink tnum">
      {count(n)}
    </span>
  );
}

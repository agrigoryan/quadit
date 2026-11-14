import type { ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  title: string;
  /** One line that says what to do next. */
  hint?: ReactNode;
  action?: ReactNode;
}

/** What a page shows when it has nothing to list: what it is for, and the next step. */
export function EmptyState({ icon, title, hint, action }: Props) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-ink-3 [&>svg]:size-7">{icon}</div>}
      <p className="text-base font-semibold text-ink">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-2">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

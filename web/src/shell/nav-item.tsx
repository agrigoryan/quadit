import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cx } from "@/lib/cx";
import { formatNumber } from "@/lib/i18n";
import { ui } from "@/lib/ui-state";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  to: string;
  icon: ReactNode;
  label: string;
  /** A count at the right; `loud` gives it the highlighter. */
  count?: number;
  loud?: boolean;
  /** Icons only: the label moves into a tooltip. */
  collapsed?: boolean;
  /** The keys that go here, shown in that tooltip. */
  hint?: string;
  /** Indented under a project. */
  nested?: boolean;
  end?: boolean;
}

export function NavItem({ to, icon, label, count, loud, collapsed, hint, nested, end }: Props) {
  const link = (
    <NavLink
      to={to}
      end={end}
      onClick={() => ui.setDrawer(false)}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        cx(
          "group flex h-7 items-center gap-2 rounded-md text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0",
          collapsed ? "w-8 justify-center" : nested ? "pr-2 pl-7" : "px-2",
          isActive ? "bg-press font-medium text-ink [&>svg]:text-ink" : "text-ink-2 hover:bg-press/60 hover:text-ink [&>svg]:text-ink-3",
        )
      }
    >
      {icon}
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && !!count && (
        <span
          className={cx(
            "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-2xs font-semibold tnum",
            loud ? "bg-move text-move-ink" : "text-ink-3",
          )}
        >
          {formatNumber(count)}
        </span>
      )}
      {collapsed && !!count && loud && <span className="absolute mt-[-14px] ml-[14px] size-2 rounded-full bg-move ring-2 ring-sunken" />}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip label={label} hint={hint} side="right">
      {link}
    </Tooltip>
  );
}

export function NavSection({ title, collapsed, children }: { title: string; collapsed?: boolean; children: ReactNode }) {
  return (
    <section className="mt-4">
      {collapsed ? <div className="mx-auto mb-1.5 h-px w-5 bg-line" /> : <h2 className="mb-1 px-2 text-xs font-medium text-ink-3">{title}</h2>}
      <div className={cx("flex flex-col gap-px", collapsed && "items-center")}>{children}</div>
    </section>
  );
}

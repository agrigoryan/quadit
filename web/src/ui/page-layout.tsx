// The layout of an area made of pages, shared by workspace settings and the
// admin area: the list of pages on the left and the page on the right (on a
// phone the list is its own screen and a page has a way back to it), and
// what a page is made of: a title, sections, bordered rows.

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";

interface NavEntry {
  /** Path under the base, e.g. "members". */
  to: string;
  label: string;
  icon: ReactNode;
}

export interface NavGroup {
  title: string;
  items: NavEntry[];
}

interface LayoutProps {
  /** Where the area lives, without a trailing slash: "/games/settings". */
  base: string;
  /** Said by screen readers for the list of pages. */
  label: string;
  groups: NavGroup[];
  children: ReactNode;
}

/** True when the address is the area's own root, where a phone shows the list. */
function useAtRoot(base: string): boolean {
  const { pathname } = useLocation();
  return pathname.replace(/\/+$/, "") === base;
}

export function NavLayout({ base, label, groups, children }: LayoutProps) {
  const atRoot = useAtRoot(base);
  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={label}
        className={cx(
          "shrink-0 overflow-y-auto border-line bg-surface md:w-56 md:border-r md:px-2 md:py-3",
          atRoot ? "max-md:w-full max-md:px-3 max-md:py-2" : "max-md:hidden",
        )}
      >
        {groups.map((group) => (
          <section key={group.title} className="mb-4 max-md:mb-5">
            <h2 className="mb-1 px-2 text-xs font-medium text-ink-3 max-md:px-1">{group.title}</h2>
            <div className="flex flex-col gap-px max-md:overflow-hidden max-md:rounded-lg max-md:border max-md:border-line max-md:gap-0">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={`${base}/${item.to}`}
                  className={({ isActive }) =>
                    cx(
                      "flex items-center gap-2 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0",
                      "h-7 rounded-md px-2 max-md:h-11 max-md:rounded-none max-md:border-b max-md:border-line max-md:px-3 max-md:last:border-b-0",
                      isActive
                        ? "bg-press font-medium text-ink [&>svg]:text-ink max-md:bg-transparent"
                        : "text-ink-2 hover:bg-hover hover:text-ink [&>svg]:text-ink-3",
                    )
                  }
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <ChevronRight className="!size-4 text-ink-3 md:hidden" aria-hidden />
                </NavLink>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <div className={cx("min-w-0 flex-1 overflow-y-auto", atRoot && "max-md:hidden")}>{children}</div>
    </div>
  );
}

interface PageProps {
  title: string;
  /** One or two sentences under the title: what this page is for. */
  lead?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  /** Where "back" goes on a phone: the area's root. */
  back: string;
  /** For a page under another page (one agent, one project): the parent's name. The way back then shows on every screen. */
  backLabel?: string;
  /** Tables want more room than forms. */
  wide?: boolean;
  children: ReactNode;
}

/** One page of settings: a title, what it is for, and its sections. */
export function Page({ title, lead, actions, back, backLabel, wide, children }: PageProps) {
  return (
    <div className={cx("mx-auto w-full px-4 pt-4 pb-16 md:px-8 md:pt-7", wide ? "max-w-5xl" : "max-w-3xl")}>
      <Link
        to={back}
        className={cx(
          "mb-2 -ml-1 inline-flex h-7 items-center gap-0.5 rounded-md pr-2 text-sm text-ink-2 hover:text-ink",
          !backLabel && "md:hidden",
        )}
      >
        <ChevronLeft className="size-4" aria-hidden />
        {backLabel ?? t("common.back")}
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {lead && <p className="mt-0.5 max-w-prose text-sm text-ink-2">{lead}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-8">{children}</div>
    </div>
  );
}

interface SectionProps {
  title?: string;
  lead?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled part of a page. */
export function Section({ title, lead, actions, children, className }: SectionProps) {
  return (
    <section className={className}>
      {(title || actions) && (
        <div className="mb-2.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {lead && <p className="mt-0.5 max-w-prose text-sm text-ink-2">{lead}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A bordered box for a form or a few facts. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-surface p-4", className)}>{children}</div>;
}

/** A bordered list: each child is one row, with a line between rows. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface", className)}>
      {children}
    </div>
  );
}

interface RowProps {
  /** An avatar or icon at the left. */
  lead?: ReactNode;
  title: ReactNode;
  /** A fainter second line. */
  sub?: ReactNode;
  /** Badges and facts between the name and the buttons; hidden on a phone when `metaWide`. */
  meta?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/** One row of a list: who or what, a few facts, and what can be done to it. */
export function Row({ lead, title, sub, meta, actions, onClick, className }: RowProps) {
  const body = (
    <>
      {lead && <span className="flex shrink-0 items-center">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{title}</span>
        {sub && <span className="block truncate text-xs text-ink-3">{sub}</span>}
      </span>
    </>
  );
  return (
    <div className={cx("flex min-h-11 items-center gap-3 px-3 py-1.5", onClick && "hover:bg-hover/60", className)}>
      {onClick ? (
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {body}
        </button>
      ) : (
        body
      )}
      {meta && <span className="flex shrink-0 items-center gap-2 text-xs text-ink-2">{meta}</span>}
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}

/** What a list says when it has nothing in it. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-2">
      {children}
    </div>
  );
}

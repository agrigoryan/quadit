// How a cell reads when it is not being edited, for every kind of property.
// Used by the table, cards, the timeline and a row's property list.

import { ArrowUpRight, Check } from "lucide-react";
import { cx } from "@/lib/cx";
import { useLookup, useMember } from "@/lib/selectors";
import { isDay } from "@/lib/days";
import { formatDay } from "@/lib/time";
import { docTitle } from "@/docs/data";
import type { Value } from "@/docs/db/formula";
import { formulaText } from "@/docs/db/formula-values";
import { findOption, OptionChip } from "@/docs/db/options";
import type { DBProperty } from "@/lib/types-docs";
import { Avatar } from "@/ui/avatar";

/** A list of strings out of whatever is stored (a property that changed type may hold anything). */
export function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string" && e !== "");
  return typeof v === "string" && v !== "" ? [v] : [];
}

export function CheckMark({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-xs border transition-colors",
        on ? "border-accent bg-accent text-accent-ink" : "border-line-strong bg-surface",
        className,
      )}
    >
      {on && <Check className="size-3" strokeWidth={3} aria-hidden />}
    </span>
  );
}

function MemberValue({ userId, fallback }: { userId: string; fallback: string }) {
  const member = useMember(userId);
  if (!member) return <span className="truncate text-ink-2">{fallback}</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar member={member} size="xs" />
      <span className="truncate">{member.name}</span>
    </span>
  );
}

function RelationValue({ ids, wrap }: { ids: string[]; wrap?: boolean }) {
  const docs = useLookup("docs");
  return (
    <span className={cx("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
      {ids.map((id) => {
        const row = docs[id];
        if (!row) return null;
        return (
          <span
            key={id}
            className="inline-flex h-5 max-w-full shrink-0 items-center gap-0.5 rounded-sm bg-sunken px-1.5 text-xs text-ink"
          >
            <ArrowUpRight className="size-3 shrink-0 text-ink-3" aria-hidden />
            <span className="truncate">{docTitle(row)}</span>
          </span>
        );
      })}
    </span>
  );
}

interface Props {
  prop: DBProperty;
  /** The value as stored on the row. */
  stored: unknown;
  /** The value worked out (a formula's result, a member's handle); what filters and sorts see. */
  shown: Value | undefined;
  /** Let chips and long text wrap instead of cutting them off. */
  wrap?: boolean;
}

/** One value, drawn for reading. Renders nothing when the cell is empty. */
export function CellValue({ prop, stored, shown, wrap }: Props) {
  const text = wrap ? "break-words whitespace-pre-wrap" : "truncate";
  switch (prop.type) {
    case "checkbox":
      return <CheckMark on={stored === true} />;
    case "select": {
      const [name] = asList(stored);
      return name ? <OptionChip option={findOption(prop, name)} /> : null;
    }
    case "multi_select": {
      const names = asList(stored);
      if (names.length === 0) return null;
      return (
        <span className={cx("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {names.map((name) => (
            <OptionChip key={name} option={findOption(prop, name)} />
          ))}
        </span>
      );
    }
    case "member":
      return typeof stored === "string" && stored ? (
        <MemberValue userId={stored} fallback={formulaText(shown)} />
      ) : null;
    case "relation": {
      const ids = asList(stored);
      return ids.length ? <RelationValue ids={ids} wrap={wrap} /> : null;
    }
    case "url": {
      const href = formulaText(shown);
      if (!href) return null;
      return (
        <a
          href={/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className={cx(
            "text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current",
            text,
          )}
        >
          {href}
        </a>
      );
    }
    case "date":
      return shown ? (
        <span className={cx("tnum", text)}>{isDay(shown) ? formatDay(shown) : formulaText(shown)}</span>
      ) : null;
    case "number":
      return shown === undefined || shown === null ? null : (
        <span className={cx("tnum", text)}>{formulaText(shown)}</span>
      );
    case "rollup": {
      if (shown === undefined || shown === null) return null;
      const out = formulaText(typeof shown === "number" ? Math.round(shown * 100) / 100 : shown);
      return <span className={cx("tnum", text)}>{prop.config?.fn === "percent_checked" ? `${out}%` : out}</span>;
    }
    case "formula": {
      const out = formulaText(shown);
      if (!out) return null;
      if (typeof shown === "boolean") return <CheckMark on={shown} />;
      const failed = out.startsWith("#error") || out === "#loop";
      return (
        <span className={cx(text, failed ? "text-danger" : "tnum")} title={failed ? out : undefined}>
          {out}
        </span>
      );
    }
  }
  const out = formulaText(shown);
  return out ? <span className={text}>{out}</span> : null;
}

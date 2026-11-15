import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { CellValue, CheckMark } from "@/docs/db/cell-value";
import type { Value } from "@/docs/db/formula";
import { PropIcon } from "@/docs/db/prop-meta";
import type { DBProperty, Doc } from "@/docs/types";

const isBlank = (v: Value | undefined) =>
  v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

/** Kinds that say little on a card: who made the row and when, and formulas that failed. */
const QUIET = ["created_at", "updated_at", "created_by"];
const worthShowing = (p: DBProperty, v: Value | undefined) =>
  !isBlank(v) && !QUIET.includes(p.type) && !(typeof v === "string" && v.startsWith("#error"));
/** Kinds whose value explains itself; the rest get their property's icon in front. */
const SELF_EVIDENT = ["select", "multi_select", "member", "relation"];

interface Props {
  row: Doc;
  cells: Record<string, Value> | undefined;
  /** The properties to show under the title; empty ones are skipped. */
  props: DBProperty[];
  className?: string;
}

/** What a row shows as a card: its title and the values that are filled in. */
export function RowCardBody({ row, cells, props, className }: Props) {
  const filled = props.filter((p) => worthShowing(p, cells?.[p.id]));
  return (
    <div className={className}>
      <p className={cx("line-clamp-3 text-sm leading-[1.35] font-medium", !row.title && "font-normal text-ink-3")}>
        {row.icon && <span className="mr-1">{row.icon}</span>}
        {row.title || t("db.untitled")}
      </p>
      {filled.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {filled.slice(0, 4).map((p) => (
            <div key={p.id} className="flex min-h-5 min-w-0 items-center gap-1.5 text-xs text-ink-2" title={p.name}>
              {p.type === "checkbox" || cells?.[p.id] === true ? (
                <>
                  <CheckMark on className="size-3.5" />
                  <span className="truncate">{p.name}</span>
                </>
              ) : (
                <>
                  {!SELF_EVIDENT.includes(p.type) && <PropIcon type={p.type} className="size-3 shrink-0 text-ink-3" />}
                  <CellValue prop={p} stored={row.props?.[p.id]} shown={cells?.[p.id]} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

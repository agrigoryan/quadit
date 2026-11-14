import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { CellValue } from "@/docs/db/cell-value";
import type { Value } from "@/docs/db/formula";
import type { DBProperty, Doc } from "@/docs/types";

const isBlank = (v: Value | undefined) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

interface Props {
  row: Doc;
  cells: Record<string, Value> | undefined;
  /** The properties to show under the title; empty ones are skipped. */
  props: DBProperty[];
  className?: string;
}

/** What a row shows as a card: its title and the values that are filled in. */
export function RowCardBody({ row, cells, props, className }: Props) {
  const filled = props.filter((p) => !isBlank(cells?.[p.id]));
  return (
    <div className={className}>
      <p className={cx("line-clamp-3 text-sm leading-[1.35] font-medium", !row.title && "font-normal text-ink-3")}>
        {row.icon && <span className="mr-1">{row.icon}</span>}
        {row.title || t("db.untitled")}
      </p>
      {filled.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {filled.slice(0, 5).map((p) => (
            <div key={p.id} className="flex min-h-5 min-w-0 items-center text-xs text-ink-2" title={p.name}>
              <CellValue prop={p} stored={row.props?.[p.id]} shown={cells?.[p.id]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

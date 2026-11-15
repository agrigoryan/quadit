import { useState } from "react";
import { Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { setRowProps } from "@/docs/actions";
import { useProperties } from "@/docs/data";
import { AddPropertyMenu } from "@/docs/db/add-property";
import { SelfCell } from "@/docs/db/cell";
import { PropIcon } from "@/docs/db/prop-meta";
import { PropertyPopover } from "@/docs/db/property-editor";
import { useDatabase, useEnsureDatabases } from "@/docs/db/use-table";
import type { Doc } from "@/types/docs";

/**
 * A database row's values as a list: the property's name, then its value,
 * changed the same way as in the table. Sits above the row's page.
 */
export function RowProperties({ row, readOnly }: { row: Doc; readOnly: boolean }) {
  const databaseId = row.parent_id;
  const props = useProperties(databaseId);
  const db = useDatabase(databaseId);
  const [open, setOpen] = useState<string | null>(null);

  // Opened by a link, the row may be here before its database's properties are.
  useEnsureDatabases(props.length === 0 ? [databaseId] : []);

  if (!databaseId) return null;
  const cells = db?.cells[row.id];
  return (
    <div className="flex flex-col gap-px">
      {props.map((p) => (
        <div key={p.id} className="flex min-h-8 items-start gap-1">
          {readOnly ? (
            <span className="flex h-8 w-36 shrink-0 items-center gap-1.5 px-1.5 text-sm text-ink-2 max-sm:w-28">
              <PropIcon type={p.type} />
              <span className="truncate">{p.name}</span>
            </span>
          ) : (
            <PropertyPopover prop={p} open={open === p.id} onOpenChange={(on) => setOpen(on ? p.id : null)}>
              <button
                type="button"
                className="flex h-8 w-36 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left text-sm text-ink-2 hover:bg-hover data-[state=open]:bg-hover max-sm:w-28"
              >
                <PropIcon type={p.type} />
                <span className="truncate">{p.name}</span>
              </button>
            </PropertyPopover>
          )}
          <div className={cx("min-w-0 flex-1 rounded-md", !readOnly && "hover:bg-hover")}>
            <SelfCell
              prop={p}
              stored={row.props?.[p.id]}
              shown={cells?.[p.id]}
              onChange={(value) => setRowProps(row.id, { [p.id]: value })}
              wrap
              placeholder={t("db.cell.empty")}
              className="min-h-8"
              readOnly={readOnly}
            />
          </div>
        </div>
      ))}
      {!readOnly && (
        <AddPropertyMenu databaseId={databaseId} onCreated={setOpen}>
          <button
            type="button"
            className="flex h-8 w-fit items-center gap-1.5 rounded-md px-1.5 text-sm text-ink-3 hover:bg-hover hover:text-ink"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("db.prop.add")}
          </button>
        </AddPropertyMenu>
      )}
    </div>
  );
}

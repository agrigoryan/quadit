import { memo, type MouseEvent } from "react";
import { Ellipsis, FileText, PanelRight, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { setRowProps, trashDoc, updateDoc } from "@/docs/actions";
import { Cell, CellInput } from "@/docs/db/cell";
import type { Value } from "@/docs/db/formula";
import { TITLE_WIDTH } from "@/docs/db/prop-meta";
import type { DBProperty, Doc } from "@/lib/types-docs";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

export const TITLE = "title";

interface Props {
  row: Doc;
  cells: Record<string, Value> | undefined;
  props: DBProperty[];
  widths: Record<string, number>;
  /** The column of this row that is selected, if any, and whether it is being edited. */
  activeCol: string | null;
  editing: boolean;
  seed?: string;
  onActive: (rowId: string, col: string) => void;
  onEditing: (rowId: string, col: string, on: boolean) => void;
  onOpen: (rowId: string) => void;
}

/**
 * A press inside the cell's own text box, or in a list opened from it (which
 * React hands up through the cell although it is drawn elsewhere), is for
 * the editor, not a new selection.
 */
const inEditor = (e: MouseEvent<HTMLElement>) =>
  (e.target as HTMLElement).tagName === "INPUT" || !e.currentTarget.contains(e.target as Node);

const cellBox = "relative flex shrink-0 items-stretch border-r border-line";
const selected = "z-[1] outline outline-2 -outline-offset-2 outline-accent";

/** One row of the table: the title, then a cell per property. */
export const TableRow = memo(function TableRow({
  row,
  cells,
  props,
  widths,
  activeCol,
  editing,
  seed,
  onActive,
  onEditing,
  onOpen,
}: Props) {
  const slug = useSlug();
  const navigate = useNavigate();
  const titleOn = activeCol === TITLE;
  return (
    <div role="row" className="group/row flex w-max min-w-full border-b border-line hover:bg-hover/40">
      <div
        role="gridcell"
        data-cell={`${row.id}:${TITLE}`}
        style={{ width: `min(${widths[TITLE] ?? TITLE_WIDTH}px, 60vw)` }}
        className={cx(
          cellBox,
          "sticky left-0 z-[2] bg-surface group-hover/row:bg-[color-mix(in_srgb,var(--hover)_40%,var(--surface))]",
          titleOn && selected,
        )}
        onMouseDown={(e) => inEditor(e) || onActive(row.id, TITLE)}
      >
        {titleOn && editing ? (
          <CellInput
            kind="text"
            label={t("db.title")}
            initial={row.title}
            seed={seed}
            onCancel={() => onEditing(row.id, TITLE, false)}
            onCommit={(text) => {
              updateDoc(row.id, { title: text.trim() });
              onEditing(row.id, TITLE, false);
            }}
          />
        ) : (
          <div
            className="flex min-h-8 w-full min-w-0 cursor-text items-center gap-1 pr-1 pl-2"
            onClick={() => onEditing(row.id, TITLE, true)}
          >
            {row.icon && <span className="shrink-0">{row.icon}</span>}
            <span className={cx("min-w-0 flex-1 truncate text-sm font-medium", !row.title && "font-normal text-ink-3")}>
              {row.title || t("db.untitled")}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(row.id);
              }}
              className="flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line bg-surface px-1 text-2xs font-medium text-ink-2 uppercase opacity-0 shadow-card group-hover/row:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 max-md:opacity-100"
            >
              <PanelRight className="size-3" aria-hidden />
              <span className="max-md:hidden">{t("db.row.open")}</span>
              <span className="sr-only md:hidden">{t("db.row.open")}</span>
            </button>
            <Menu>
              <MenuTrigger
                aria-label={t("db.row.more")}
                onClick={(e) => e.stopPropagation()}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 group-hover/row:opacity-100 hover:bg-press hover:text-ink focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:hidden"
              >
                <Ellipsis className="size-3.5" aria-hidden />
              </MenuTrigger>
              <MenuContent onClick={(e) => e.stopPropagation()}>
                <MenuItem icon={<PanelRight />} onSelect={() => onOpen(row.id)}>
                  {t("db.row.peek")}
                </MenuItem>
                <MenuItem icon={<FileText />} onSelect={() => navigate(`/${slug}/docs/${row.id}`)}>
                  {t("db.row.page")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 />} onSelect={() => trashDoc(row.id)}>
                  {t("db.row.delete")}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        )}
      </div>
      {props.map((p) => {
        const on = activeCol === p.id;
        return (
          <div
            key={p.id}
            role="gridcell"
            data-cell={`${row.id}:${p.id}`}
            style={{ width: widths[p.id] }}
            className={cx(cellBox, on && selected)}
            onMouseDown={(e) => inEditor(e) || onActive(row.id, p.id)}
          >
            <Cell
              prop={p}
              stored={row.props?.[p.id]}
              shown={cells?.[p.id]}
              editing={on && editing}
              seed={on ? seed : undefined}
              onEditing={(next) => onEditing(row.id, p.id, next)}
              onChange={(value) => setRowProps(row.id, { [p.id]: value })}
              className="min-h-8"
            />
          </div>
        );
      })}
      <div className="min-w-10 flex-1" />
    </div>
  );
});

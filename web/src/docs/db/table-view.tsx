// oxlint-disable jsx-a11y/prefer-tag-over-role -- the table is a grid of flex rows, with a sticky title column and columns that are dragged and resized, which a <table> cannot lay out
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { Plus, Type } from "lucide-react";
import { t } from "@/lib/i18n";
import { setRowProps, trashDoc } from "@/docs/actions";
import { setViewConfig } from "@/docs/db/actions";
import { AddPropertyMenu } from "@/docs/db/add-property";
import { takesTyping } from "@/docs/db/cell";
import { isComputed, PROP_WIDTHS, TITLE_WIDTH } from "@/docs/db/prop-meta";
import { HeaderCell } from "@/docs/db/table-header";
import { cellId, TableRow, TITLE } from "@/docs/db/table-row";
import { shownProps, type ViewProps } from "@/docs/db/use-table";

interface Active {
  row: string;
  col: string;
}

/**
 * Rows and properties as a grid. Click a cell to change it; with the
 * keyboard, arrows move, Enter opens the cell, typing starts writing,
 * Backspace clears, Space opens the row, Tab goes on to the next cell.
 */
export function TableView({ db, view, rows, onOpen, onAdd, peek, readOnly }: ViewProps) {
  const props = useMemo(() => shownProps(db.table.props, view), [db.table.props, view]);
  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<{ seed?: string } | null>(null);
  const [openProp, setOpenProp] = useState<string | null>(null);
  const [resize, setResize] = useState<{ id: string; width: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const widths = useMemo(() => {
    const out: Record<string, number> = { [TITLE]: view.config?.widths?.[TITLE] ?? TITLE_WIDTH };
    for (const p of props) out[p.id] = view.config?.widths?.[p.id] ?? PROP_WIDTHS[p.type] ?? 160;
    if (resize) out[resize.id] = resize.width;
    return out;
  }, [props, view.config?.widths, resize]);

  const cols = useMemo(() => [TITLE, ...props.map((p) => p.id)], [props]);

  // After an editor closes the grid takes the keys again, unless the person went elsewhere.
  // (A moment later: a list that is closing still holds the focus when this runs.)
  useEffect(() => {
    if (editing || !active) return;
    const timer = setTimeout(() => {
      const el = document.activeElement;
      if (!el || el === document.body || grid.current?.contains(el)) grid.current?.focus({ preventScroll: true });
    }, 40);
    return () => clearTimeout(timer);
  }, [editing, active]);

  useEffect(() => {
    if (!active) return;
    const cell = grid.current?.querySelector(`[data-cell="${active.row}:${active.col}"]`);
    const box = grid.current?.parentElement;
    if (!cell || !box) return;
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    // The title column stays put while the rest scrolls: a cell must clear it to be seen.
    const pinned =
      grid.current?.querySelector(`[data-cell="${active.row}:${TITLE}"]`)?.getBoundingClientRect().right ?? 0;
    const left = cell.getBoundingClientRect().left;
    // oxlint-disable-next-line react/immutability -- the table's scroller, scrolled to show the active cell: what an effect is for
    if (active.col !== TITLE && left < pinned) box.scrollLeft -= pinned - left;
  }, [active]);

  const onActive = useCallback((row: string, col: string) => {
    setActive((cur) => (cur?.row === row && cur.col === col ? cur : { row, col }));
    setEditing((cur) => (cur ? null : cur));
    if (document.activeElement !== grid.current) grid.current?.focus({ preventScroll: true });
  }, []);

  const onEditing = useCallback(
    (row: string, col: string, on: boolean) => {
      if (on && readOnly) return;
      if (on) setActive({ row, col });
      setEditing(on ? {} : null);
    },
    [readOnly],
  );

  function move(dRow: number, dCol: number, wrap = false) {
    if (!active) return;
    let r = rows.findIndex((x) => x.id === active.row);
    let c = cols.indexOf(active.col) + dCol;
    if (wrap && c >= cols.length) [r, c] = [r + 1, 0];
    if (wrap && c < 0) [r, c] = [r - 1, cols.length - 1];
    r = Math.min(rows.length - 1, Math.max(0, r + dRow));
    c = Math.min(cols.length - 1, Math.max(0, c));
    const row = rows[r];
    const col = cols[c];
    if (row && col) setActive({ row: row.id, col });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // Keys from a menu or a list opened over the table are not for the grid.
    const inCell = target === grid.current || (target.tagName === "INPUT" && !!target.closest("[data-cell]"));
    if (e.key === "Tab" && active && inCell) {
      const r = rows.findIndex((x) => x.id === active.row);
      const c = cols.indexOf(active.col);
      const atEnd = e.shiftKey ? r === 0 && c === 0 : r === rows.length - 1 && c === cols.length - 1;
      if (atEnd) return; // leave the table
      e.preventDefault();
      setEditing(null);
      move(0, e.shiftKey ? -1 : 1, true);
      return;
    }
    if (editing || !active || target !== grid.current) return;
    const prop = props.find((p) => p.id === active.col);
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      move(arrow[0], arrow[1]);
    } else if (e.key === " ") {
      e.preventDefault();
      onOpen(active.row);
    } else if (e.key === "Escape") {
      e.preventDefault(); // used up here: a second Escape leaves the page, and the comments beside it stay open
      setActive(null);
    } else if (peek && (e.key === "Enter" || (!e.shiftKey && /^[jk]$/i.test(e.key)))) {
      // With a row open beside, J and K (Caps Lock or not) step it and Enter opens it as a page
      // (docs/db/database-page.tsx); Shift+J types a J. A click on Open leaves a cell chosen.
    } else if (readOnly) {
      // Moving about and opening rows only.
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (prop?.type === "checkbox")
        setRowProps(active.row, { [prop.id]: rows.find((r) => r.id === active.row)?.props?.[prop.id] !== true });
      else if (!prop || !isComputed(prop)) setEditing({});
    } else if ((e.key === "Backspace" || e.key === "Delete") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      move(1, 0);
      trashDoc(active.row);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (prop && !isComputed(prop)) setRowProps(active.row, { [prop.id]: null });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && (!prop || takesTyping(prop))) {
      e.preventDefault();
      setEditing({ seed: e.key });
    }
  }

  function reorder(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = props.map((p) => p.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    // Hidden properties keep their place after the ones in view.
    const rest = shownProps(db.table.props, view, true)
      .map((p) => p.id)
      .filter((id) => !next.includes(id));
    setViewConfig(view, { order: [...next, ...rest] });
  }

  function addRow() {
    const id = onAdd();
    setActive({ row: id, col: TITLE });
    setEditing({});
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div
        ref={grid}
        role="grid"
        tabIndex={0}
        aria-label={view.name}
        aria-rowcount={rows.length}
        aria-activedescendant={active ? cellId(active.row, active.col) : undefined}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target === grid.current && !active && rows[0] && setActive({ row: rows[0].id, col: TITLE })}
        className="w-max min-w-full border-t border-line outline-none"
      >
        <div role="row" className="flex w-max min-w-full border-b border-line bg-surface">
          <div
            role="columnheader"
            style={{ width: `min(${widths[TITLE]}px, 60vw)` }}
            className="sticky left-0 z-[2] flex h-8 shrink-0 items-center gap-1.5 border-r border-line bg-surface px-2 text-xs font-medium text-ink-2"
          >
            <Type className="size-3.5 text-ink-3" aria-hidden />
            {t("db.title")}
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
            <SortableContext items={props.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
              {props.map((p) => (
                <HeaderCell
                  key={p.id}
                  prop={p}
                  view={view}
                  readOnly={readOnly}
                  width={widths[p.id] ?? 160}
                  open={openProp === p.id}
                  onOpenChange={(open) => setOpenProp(open ? p.id : null)}
                  onResize={(width, done) => {
                    setResize(done ? null : { id: p.id, width });
                    if (done) setViewConfig(view, { widths: { ...view.config?.widths, [p.id]: width } });
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
          {!readOnly && (
            <AddPropertyMenu databaseId={db.table.doc.id} onCreated={setOpenProp} align="end">
              <button
                type="button"
                aria-label={t("db.prop.add")}
                className="flex h-8 w-10 shrink-0 items-center justify-center text-ink-3 hover:bg-hover hover:text-ink"
              >
                <Plus className="size-4" aria-hidden />
              </button>
            </AddPropertyMenu>
          )}
          <div className="flex-1" />
        </div>

        {rows.map((row) => {
          const on = active?.row === row.id;
          return (
            <TableRow
              key={row.id}
              row={row}
              cells={db.cells[row.id]}
              props={props}
              widths={widths}
              activeCol={on ? (active?.col ?? null) : null}
              editing={on && !!editing}
              seed={on ? editing?.seed : undefined}
              onActive={onActive}
              onEditing={onEditing}
              onOpen={onOpen}
              readOnly={readOnly}
            />
          );
        })}
      </div>
      {!readOnly && (
        <button
          type="button"
          onClick={addRow}
          className="sticky left-0 flex h-8 w-full items-center gap-1.5 px-2 text-sm text-ink-3 hover:bg-hover hover:text-ink"
        >
          <Plus className="size-4" aria-hidden />
          {t("db.newRow")}
        </button>
      )}
      <p className="sticky left-0 px-2 pt-1 text-xs text-ink-3 tnum">{t("db.rowCount", { n: rows.length })}</p>
    </div>
  );
}

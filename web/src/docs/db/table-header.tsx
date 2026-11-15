// oxlint-disable jsx-a11y/prefer-tag-over-role -- the table is a grid of flex rows, with a sticky title column and columns that are dragged and resized, which a <table> cannot lay out; a column's resize handle is a separator drawn as a line, which an <hr> cannot be
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { PropIcon } from "@/docs/db/prop-meta";
import { PropertyPopover } from "@/docs/db/property-editor";
import type { DBProperty, DBView } from "@/types/docs";

const MIN_WIDTH = 72;
const MAX_WIDTH = 1200;
/** How far one press of Left or Right moves a column's edge, and with Shift. */
const STEP = 10;
const BIG_STEP = 50;

const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

interface Props {
  prop: DBProperty;
  view: DBView;
  width: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called while the edge is dragged or its arrow key held, and with `done` when it is let go. */
  onResize: (width: number, done: boolean) => void;
  /** Only the name: no settings, no moving, no resizing. */
  readOnly: boolean;
}

/**
 * A column's name. Click it for the property's settings, drag it to reorder,
 * drag its edge to resize. The edge is a window splitter the keyboard moves
 * too: Left and Right, with Shift for bigger steps.
 */
export function HeaderCell({ prop, view, width, open, onOpenChange, onResize, readOnly }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: prop.id,
    disabled: readOnly,
  });
  const [resizing, setResizing] = useState(false);

  function startResize(e: ReactPointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const from = e.clientX;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const at = (ev: PointerEvent) => clampWidth(width + ev.clientX - from);
    const move = (ev: PointerEvent) => onResize(at(ev), false);
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setResizing(false);
      onResize(at(ev), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  const arrows: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
  // Each press shows the new width; letting go of the key keeps it, so a held key makes one change.
  function nudge(e: KeyboardEvent<HTMLSpanElement>) {
    const direction = arrows[e.key];
    if (!direction) return;
    // The table's own keys move between its cells.
    e.preventDefault();
    e.stopPropagation();
    onResize(clampWidth(width + direction * (e.shiftKey ? BIG_STEP : STEP)), false);
  }
  function keep(e: KeyboardEvent<HTMLSpanElement>) {
    if (!arrows[e.key]) return;
    e.stopPropagation();
    onResize(width, true);
  }

  return (
    <div
      ref={setNodeRef}
      role="columnheader"
      // Named by the property alone, not by its handle's width too.
      aria-label={prop.name}
      style={{ width, transform: CSS.Translate.toString(transform && { ...transform, y: 0 }), transition }}
      className={cx("relative shrink-0 border-r border-line", isDragging && "z-10 bg-hover opacity-80")}
    >
      {readOnly ? (
        <span className="flex h-8 w-full items-center gap-1.5 px-2 text-xs font-medium text-ink-2">
          <PropIcon type={prop.type} />
          <span className="truncate">{prop.name}</span>
        </span>
      ) : (
        <PropertyPopover prop={prop} view={view} open={open} onOpenChange={onOpenChange}>
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="flex h-8 w-full items-center gap-1.5 px-2 text-left text-xs font-medium text-ink-2 hover:bg-hover data-[state=open]:bg-hover"
          >
            <PropIcon type={prop.type} />
            <span className="truncate">{prop.name}</span>
          </button>
        </PropertyPopover>
      )}
      {!readOnly && (
        <span
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t("db.table.resize", { name: prop.name })}
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          onPointerDown={startResize}
          onKeyDown={nudge}
          onKeyUp={keep}
          className={cx(
            "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 hover:after:bg-accent focus-visible:after:bg-accent",
            resizing && "after:bg-accent",
          )}
        />
      )}
    </div>
  );
}

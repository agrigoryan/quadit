// A "before" and an "after" picture shown as one: the after lies over the
// before and a divider wipes between them. The divider is a slider: drag
// it, or move it with the arrow keys.

import { type CSSProperties, type KeyboardEvent, type PointerEvent, useState } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { OptionFile } from "@/decisions/data";
import { FIT, type View } from "@/decisions/use-zoom";

const within = (n: number) => Math.min(100, Math.max(0, n));

/**
 * Cuts the "after" picture at the divider. `pos` is where the divider
 * stands across the box on screen, 0 to 100; under a zoom the cut is worked
 * back into the picture's own box, so the divider stays where it is put.
 */
export function afterClip(pos: number, view: View = FIT): CSSProperties {
  const local = within(((pos / 100 - 0.5 - view.x) / view.k + 0.5) * 100);
  return { clipPath: `inset(0 0 0 ${local}%)` };
}

interface HandleProps {
  /** 0 is the left edge (all "after"), 100 the right (all "before"). */
  pos: number;
  onChange: (pos: number) => void;
}

/** The divider with its grip. Place it in the box the pictures fill. */
export function SwipeHandle({ pos, onChange }: HandleProps) {
  function follow(e: PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (box && box.width > 0) onChange(within(((e.clientX - box.left) / box.width) * 100));
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 10 : 2;
    const to: Record<string, number | undefined> = { ArrowLeft: pos - step, ArrowRight: pos + step, Home: 0, End: 100 };
    const next = to[e.key];
    if (next === undefined) return;
    // The compare view moves between options with the same keys: not while the divider has the focus.
    e.preventDefault();
    e.stopPropagation();
    onChange(within(next));
  }
  // The box may also open, zoom or pan on the same gestures: the divider keeps them to itself.
  const mine = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t("decision.pair.slider")}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos)}
      aria-valuetext={t("decision.pair.value", { n: Math.round(pos) })}
      onPointerDown={(e) => {
        mine(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        follow(e);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        mine(e);
        follow(e);
      }}
      onPointerUp={mine}
      onClick={mine}
      onDoubleClick={mine}
      onKeyDown={onKey}
      style={{ left: `${pos}%` }}
      className="group/swipe absolute inset-y-0 z-[1] w-7 -translate-x-1/2 cursor-ew-resize touch-none outline-none max-sm:w-11"
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.35)]" />
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-pop ring-accent group-focus-visible/swipe:ring-2 max-sm:size-8"
      >
        <ChevronsLeftRight className="size-3.5" />
      </span>
    </div>
  );
}

const tag = "pointer-events-none absolute z-[1] flex h-5 items-center rounded-sm bg-black/60 px-1.5 text-2xs font-medium text-white";

/** "Before" and "After" in the bottom corners, on the side each picture shows through. */
export function PairLabels() {
  return (
    <>
      <span className={cx(tag, "bottom-1.5 left-1.5")}>{t("decision.pair.before")}</span>
      <span className={cx(tag, "right-1.5 bottom-1.5")}>{t("decision.pair.after")}</span>
    </>
  );
}

/** A single picture's mark when it is one half of a change and the other half is missing. */
export function RoleLabel({ role }: { role: "before" | "after" }) {
  return <span className={cx(tag, "bottom-1.5 left-1.5")}>{t(`decision.pair.${role}`)}</span>;
}

interface PairProps {
  /** The "after" picture, carrying its "before". */
  file: OptionFile;
  src: (file: OptionFile) => string;
  pixelated?: boolean;
  /** Makes the pictures a button (the divider stays its own control). */
  onOpen?: () => void;
  openLabel?: string;
}

const layer = "absolute inset-0 size-full object-contain";

/** The pair in a box of its own, with the divider: before under after. */
export function SwipePair({ file, src, pixelated, onOpen, openLabel }: PairProps) {
  const [pos, setPos] = useState(50);
  const before = file.before;
  if (!before) return null;
  const rendering = pixelated ? ("pixelated" as const) : undefined;
  const pictures = (
    <>
      <img src={src(before)} alt={t("decision.pair.beforeAlt", { name: before.name })} draggable={false} loading="lazy" className={layer} style={{ imageRendering: rendering }} />
      <img
        src={src(file)}
        alt={t("decision.pair.afterAlt", { name: file.name })}
        draggable={false}
        loading="lazy"
        className={layer}
        style={{ imageRendering: rendering, ...afterClip(pos) }}
      />
    </>
  );
  return (
    <div className="relative size-full overflow-hidden select-none">
      {onOpen ? (
        <button type="button" aria-label={openLabel} onClick={onOpen} className="absolute inset-0 cursor-zoom-in focus-visible:-outline-offset-2">
          {pictures}
        </button>
      ) : (
        pictures
      )}
      <PairLabels />
      <SwipeHandle pos={pos} onChange={setPos} />
    </div>
  );
}

/** The pair side by side, each half with its name: for a box wide enough to show both. */
export function SidePair({ file, src, pixelated, onOpen, openLabel }: PairProps) {
  const before = file.before;
  if (!before) return null;
  const rendering = pixelated ? ("pixelated" as const) : undefined;
  const half = (shown: OptionFile, role: "before" | "after") => (
    <span className="relative block min-w-0 bg-sunken">
      <img
        src={src(shown)}
        alt={t(`decision.pair.${role}Alt`, { name: shown.name })}
        draggable={false}
        loading="lazy"
        className={layer}
        style={{ imageRendering: rendering }}
      />
      <span className={cx(tag, "bottom-1.5 left-1.5")}>{t(`decision.pair.${role}`)}</span>
    </span>
  );
  return (
    <button
      type="button"
      aria-label={openLabel}
      onClick={onOpen}
      className="grid size-full cursor-zoom-in grid-cols-2 gap-px bg-line focus-visible:-outline-offset-2"
    >
      {half(before, "before")}
      {half(file, "after")}
    </button>
  );
}

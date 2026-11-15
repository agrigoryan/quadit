// The panes of the compare view: each shows one option's picture or video
// under the shared zoom, with its label and its pick button below.

import { useCallback, useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { cx } from "@/lib/cx";
import { isVideo } from "@/data/files";
import { t } from "@/lib/i18n";
import type { DecisionOption } from "@/types/core";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { afterClip, PairLabels, RoleLabel, SwipeHandle } from "@/decisions/before-after";
import { type Compare, paneNote } from "@/decisions/compare-state";
import { isSmallArt, type OptionFile } from "@/decisions/data";
import { FileStepper } from "@/decisions/file-stepper";
import { PickedBadge, RecommendedBadge } from "@/decisions/option-marks";

interface Size {
  w: number;
  h: number;
}

interface MediaProps {
  c: Compare;
  option: DecisionOption;
  /** This pane's picture is the one the zoom percentage is measured on. */
  gauge: boolean;
  /** Leave sideways swipes to the carousel while the picture fits (phones). */
  swipeThrough?: boolean;
}

/** One option's file in a viewport that zooms and pans with all the others. */
export function PaneMedia({ c, option, gauge, swipeThrough }: MediaProps) {
  const file = c.fileOf(option);
  const { view, isFit } = c.zoom;
  const { ref: wheel, ...handlers } = c.zoom.bind;
  const [box, setBox] = useState<Size | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; size: Size } | null>(null);
  /** Where the divider of a before/after pair stands across the pane, 0 to 100. */
  const [swipe, setSwipe] = useState(50);
  const { setFit, setVideo, setSmallArt } = c;

  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return undefined;
      const stopWheel = wheel(el);
      const watcher = new ResizeObserver(
        ([entry]) => entry && setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
      );
      watcher.observe(el);
      return () => {
        stopWheel?.();
        watcher.disconnect();
      };
    },
    [wheel],
  );
  const video = useCallback((el: HTMLVideoElement | null) => setVideo(option.id, el), [setVideo, option.id]);

  // One pane says how big "fit" is, so the header can show the zoom as a percentage.
  const natural: Size | null =
    file?.width && file.height
      ? { w: file.width, h: file.height }
      : loaded && loaded.id === file?.id
        ? loaded.size
        : null;
  const fit = box && natural && natural.w > 0 && natural.h > 0 ? Math.min(box.w / natural.w, box.h / natural.h) : 0;
  useEffect(() => {
    if (gauge && fit > 0) setFit(fit);
  }, [gauge, fit, setFit]);
  const sharp = c.sharp(natural?.w, natural?.h);
  const known = natural !== null;
  const small = !!natural && isSmall(natural);
  useEffect(() => {
    if (gauge && known) setSmallArt(small);
  }, [gauge, known, small, setSmallArt]);

  if (!file) return <NoMedia />;
  const rendering = sharp ? ("pixelated" as const) : undefined;
  const picture = "size-full object-contain";
  return (
    <div
      ref={attach}
      {...handlers}
      className={cx(
        "relative min-h-0 flex-1 overflow-hidden select-none",
        swipeThrough && isFit ? "touch-pan-x" : "touch-none",
        isFit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.k})` }}
      >
        {isVideo(file) ? (
          <video
            key={file.id}
            ref={video}
            src={file.url}
            muted
            playsInline
            loop
            preload="auto"
            aria-label={file.name}
            onLoadedMetadata={(e) =>
              setLoaded({ id: file.id, size: { w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight } })
            }
            className={picture}
            style={{ imageRendering: rendering }}
          />
        ) : (
          <>
            {file.before && (
              <img
                key={file.before.id}
                src={file.before.url}
                alt={t("decision.pair.beforeAlt", { name: file.before.name })}
                draggable={false}
                className={cx(picture, "absolute inset-0")}
                style={{ imageRendering: rendering }}
              />
            )}
            <img
              key={file.id}
              src={file.url}
              alt={file.before ? t("decision.pair.afterAlt", { name: file.name }) : file.name}
              draggable={false}
              onLoad={(e) =>
                setLoaded({ id: file.id, size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight } })
              }
              className={cx(picture, file.before && "absolute inset-0")}
              style={{ imageRendering: rendering, ...(file.before ? afterClip(swipe, view) : undefined) }}
            />
          </>
        )}
      </div>
      {file.before ? (
        <>
          <PairLabels />
          <SwipeHandle pos={swipe} onChange={setSwipe} />
        </>
      ) : (
        file.role && <RoleLabel role={file.role} />
      )}
    </div>
  );
}

const isSmall = (size: Size) => isSmallArt(size.w, size.h);

function NoMedia() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <ImageOff className="size-5 text-inverse-ink/50" aria-hidden />
      <p className="text-sm text-inverse-ink/70">{t("compare.noMedia")}</p>
    </div>
  );
}

function Pane({ c, option, index, gauge }: { c: Compare; option: DecisionOption; index: number; gauge: boolean }) {
  const focused = c.focus === index;
  const files: OptionFile[] = c.filesOf(option);
  return (
    <section
      aria-label={option.label}
      aria-current={focused ? "true" : undefined}
      onPointerDown={() => !focused && c.focusOn(index)}
      className="relative flex min-h-0 min-w-0 flex-col bg-black"
    >
      <PaneMedia c={c} option={option} gauge={gauge} />
      <footer className="shrink-0 bg-inverse px-3 py-2">
        <div className="flex h-6 items-center gap-2">
          {index < 9 && <Kbd onDark>{String(index + 1)}</Kbd>}
          <h3 className="min-w-0 truncate text-sm font-semibold text-inverse-ink">{option.label}</h3>
          {c.decision.picked_option_id === option.id && <PickedBadge />}
          {c.decision.recommended_option_id === option.id && <RecommendedBadge />}
          <span className="flex-1" />
          <FileStepper
            onDark
            index={c.fileIndexOf(option)}
            total={files.length}
            onStep={(delta) => c.stepFile(option, delta)}
          />
        </div>
        <div className="mt-1 flex h-7 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-inverse-ink/70">{paneNote(c, option)}</p>
          {c.viewer.canAnswer && (
            <Button variant={c.viewer.mine ? "move" : "secondary"} onClick={() => c.onPick(option.id)}>
              {t("decision.pick")}
            </Button>
          )}
        </div>
      </footer>
      {focused && <span aria-hidden className="pointer-events-none absolute inset-0 ring-2 ring-white ring-inset" />}
    </section>
  );
}

/** The options on this page of the stage, side by side. */
export function CompareStage({ c, visible, first }: { c: Compare; visible: DecisionOption[]; first: number }) {
  // The zoom is read off the focused picture, or the first one on stage when the focused option has none.
  const gauge = c.focused && c.fileOf(c.focused) ? c.focused : visible.find((o) => c.fileOf(o));
  return (
    <div
      className="grid min-h-0 flex-1 gap-px bg-white/15"
      style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))` }}
    >
      {visible.map((option, i) => (
        <Pane key={option.id} c={c} option={option} index={first + i} gauge={gauge?.id === option.id} />
      ))}
    </div>
  );
}

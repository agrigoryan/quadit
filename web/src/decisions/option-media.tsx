// The media at the top of an option card: one picture or video at a time in
// a box whose shape is fixed before anything loads, so cards never jump. A
// "before" and "after" picture are one entry: side by side when the card is
// wide enough, wiped between with a divider when it is not. A button in the
// corner, always shown, opens what is shown over the whole screen.

import { useCallback, useState } from "react";
import { FileText, Maximize2 } from "lucide-react";
import { isVideo } from "@/data/files";
import { t } from "@/lib/i18n";
import { useMember } from "@/data/selectors";
import type { FileRow } from "@/types/core";
import { Tooltip } from "@/ui/tooltip";
import { RoleLabel, SidePair, SwipePair } from "@/decisions/before-after";
import { isSmallArt, nameOf, type OptionFile } from "@/decisions/data";
import { FileStepper } from "@/decisions/file-stepper";

const isSprite = (file: FileRow) => isSmallArt(file.width, file.height);

/** A GIF's reduced copy is a still, so an animation is shown from the file itself. */
export const thumbOf = (file: FileRow) => (file.content_type === "image/gif" ? file.url : file.preview_url || file.url);

/** From this width a pair's two pictures fit next to each other. */
const SIDE_BY_SIDE = 300;

/** The width of an element, followed as it changes. */
function useWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const watcher = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  return [ref, width];
}

/** "Attached by @artist": who put the file shown on the option. */
function AttachedBy({ file }: { file: OptionFile }) {
  const before = useMember(file.before?.attachedBy);
  const by = useMember(file.attachedBy);
  const ids = [...new Set([file.before?.attachedBy, file.attachedBy].filter((id): id is string => !!id))];
  const names = ids.map((id) => nameOf(id === file.attachedBy ? by : before, t("common.someone"))).join(", ");
  return <p className="truncate px-3 pt-1.5 text-2xs text-ink-3">{t("decision.file.by", { name: names })}</p>;
}

/** Keeps the cards of one decision level when only some of them have media. */
export function NoMediaCaption() {
  return (
    <p aria-hidden className="px-3 pt-1.5 text-2xs">
      &nbsp;
    </p>
  );
}

interface Props {
  files: OptionFile[];
  label: string;
  /** Width over height of the box. */
  aspect: number;
  /** Opens the option over the whole screen, on the file shown. */
  onOpen: (fileIndex: number) => void;
}

/** The corner button that opens the picture or video big; dark with a light edge, so it reads on any picture. */
function OpenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip label={t("decision.openTip")}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="absolute top-1.5 right-1.5 z-[2] flex size-8 items-center justify-center rounded-md bg-black/60 text-white ring-1 ring-white/30 hover:bg-black/80 max-sm:size-9"
      >
        <Maximize2 className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function OptionMedia({ files, label, aspect, onOpen }: Props) {
  const [shown, setShown] = useState(0);
  const [box, width] = useWidth();
  const index = Math.min(shown, files.length - 1);
  const file = files[index];
  if (!file) return null;
  const open = () => onOpen(index);
  const pair = { file, src: thumbOf, pixelated: isSprite(file) };

  return (
    <>
      <div ref={box} className="relative overflow-hidden rounded-t-[9px] bg-sunken" style={{ aspectRatio: aspect }}>
        {file.before ? (
          width >= SIDE_BY_SIDE ? (
            <SidePair {...pair} onOpen={open} />
          ) : (
            <SwipePair {...pair} />
          )
        ) : isVideo(file) ? (
          <video
            key={file.id}
            src={file.url}
            poster={file.preview_url}
            controls
            playsInline
            preload="metadata"
            aria-label={file.name}
            className="size-full object-contain"
          />
        ) : (
          // A larger target for a pointer; the corner button is the one the keyboard and screen readers get.
          <button type="button" tabIndex={-1} aria-hidden onClick={open} className="block size-full cursor-zoom-in">
            <img
              src={thumbOf(file)}
              alt={file.name}
              width={file.width}
              height={file.height}
              loading="lazy"
              decoding="async"
              className="size-full object-contain"
              style={isSprite(file) ? { imageRendering: "pixelated" } : undefined}
            />
            {file.role && <RoleLabel role={file.role} />}
          </button>
        )}
        <OpenButton label={t("decision.open", { label })} onClick={open} />
        <FileStepper
          index={index}
          total={files.length}
          onStep={(delta) => setShown(index + delta)}
          className="absolute top-1.5 left-1.5 z-[2] rounded-md bg-surface shadow-card"
        />
      </div>
      <AttachedBy file={file} />
    </>
  );
}

/** Files of an option that are not pictures or video: plain links. */
export function OptionDocs({ files }: { files: OptionFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.attachmentId} className="flex min-w-0 items-baseline">
          <a
            href={file.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            <FileText className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{file.name}</span>
          </a>
          <DocBy file={file} />
        </li>
      ))}
    </ul>
  );
}

function DocBy({ file }: { file: OptionFile }) {
  const name = nameOf(useMember(file.attachedBy), t("common.someone"));
  return <span className="ml-1.5 shrink-0 text-2xs text-ink-3">{t("decision.file.by", { name })}</span>;
}

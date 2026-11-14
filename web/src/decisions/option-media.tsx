// The media at the top of an option card: one picture or video at a time in
// a box whose shape is fixed before anything loads, so cards never jump.

import { useState } from "react";
import { FileText, Maximize2 } from "lucide-react";
import { isVideo } from "@/lib/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/lib/types";
import { FileStepper } from "@/decisions/parts";

/** Pictures this small are sprite art: scale them up with hard pixel edges. */
const isSprite = (file: FileRow) => !!file.width && !!file.height && Math.max(file.width, file.height) <= 256;

/** A GIF's reduced copy is a still, so an animation is shown from the file itself. */
const thumbOf = (file: FileRow) => (file.content_type === "image/gif" ? file.url : file.preview_url || file.url);

interface Props {
  files: FileRow[];
  label: string;
  /** Width over height of the box. */
  aspect: number;
  /** Opens the compare view at this option, on the file shown. */
  onOpen: (fileIndex: number) => void;
}

export function OptionMedia({ files, label, aspect, onOpen }: Props) {
  const [shown, setShown] = useState(0);
  const index = Math.min(shown, files.length - 1);
  const file = files[index];
  if (!file) return null;
  const open = t("decision.openCompare", { label });

  return (
    <div className="relative overflow-hidden rounded-t-[9px] bg-sunken" style={{ aspectRatio: aspect }}>
      {isVideo(file) ? (
        <>
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
          <button
            type="button"
            aria-label={open}
            title={open}
            onClick={() => onOpen(index)}
            className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-md bg-black/55 text-white hover:bg-black/70 max-sm:size-9"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={open}
          onClick={() => onOpen(index)}
          className="block size-full cursor-zoom-in focus-visible:-outline-offset-2"
        >
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
        </button>
      )}
      <FileStepper
        index={index}
        total={files.length}
        onStep={(delta) => setShown(index + delta)}
        className="absolute top-1.5 left-1.5 rounded-md bg-surface shadow-card"
      />
    </div>
  );
}

/** Files of an option that are not pictures or video: plain links. */
export function OptionDocs({ files }: { files: FileRow[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.id}>
          <a
            href={file.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            <FileText className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{file.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

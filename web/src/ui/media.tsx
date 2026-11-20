import { useRef } from "react";
import { FileText, Play, X } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { cx } from "@/lib/cx";
import { fileSize, isImage, isVideo } from "@/data/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { CarouselArrows, CarouselCount, onCarouselKey, type Steps } from "@/ui/carousel";

interface ThumbProps {
  file: FileRow;
  className?: string;
  /** Fit the whole picture inside the box instead of filling and cropping. */
  contain?: boolean;
}

/**
 * A still preview of a file: the picture, a video's first frame with a play
 * mark, or an icon and name for anything else. It reserves its space from
 * the file's width and height, so nothing jumps when it loads.
 */
export function MediaThumb({ file, className, contain }: ThumbProps) {
  const fit = contain ? "object-contain" : "object-cover";
  if (isImage(file)) {
    return (
      <img
        src={file.preview_url || file.url}
        alt={file.name}
        width={file.width}
        height={file.height}
        loading="lazy"
        decoding="async"
        className={cx("bg-sunken", fit, className)}
      />
    );
  }
  if (isVideo(file)) {
    return (
      <span className={cx("relative block overflow-hidden bg-sunken", className)}>
        {file.preview_url ? (
          <img src={file.preview_url} alt={file.name} className={cx("size-full", fit)} loading="lazy" />
        ) : (
          <video src={file.url} preload="metadata" muted playsInline className={cx("size-full", fit)} />
        )}
        <span className="absolute inset-0 m-auto flex size-8 items-center justify-center rounded-full bg-black/55 text-white">
          <Play className="size-4 translate-x-px fill-current" aria-hidden />
        </span>
      </span>
    );
  }
  return (
    <span
      className={cx("flex flex-col items-center justify-center gap-1 bg-sunken p-2 text-center text-ink-2", className)}
    >
      <FileText className="size-5" aria-hidden />
      <span className="line-clamp-2 text-2xs break-all">{file.name}</span>
      <span className="text-2xs text-ink-3">{fileSize(file.size)}</span>
    </span>
  );
}

/** The file itself at full size: a picture, or a video with controls. */
function MediaFull({ file, className }: { file: FileRow; className?: string }) {
  if (isVideo(file)) {
    return (
      <video
        src={file.url}
        controls
        playsInline
        preload="metadata"
        className={cx("max-h-full max-w-full", className)}
      />
    );
  }
  return (
    <img
      src={file.url}
      alt={file.name}
      width={file.width}
      height={file.height}
      className={cx("max-h-full max-w-full object-contain", className)}
    />
  );
}

interface LightboxProps {
  /** The file shown; null while it is closed. */
  file: FileRow | null;
  /** The pictures and videos it is one of, in their order. */
  files: FileRow[];
  /** Asked for another of them. */
  onShow: (file: FileRow) => void;
  onClose: () => void;
}

/** The close button, in the look of the carousel's arrows. */
const round =
  "flex size-10 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75";

/**
 * One file over the whole screen. Escape or a click outside closes it. When
 * it is one of several, the arrows on its sides and the arrow keys go to the
 * ones beside it, and round from the last to the first.
 */
export function Lightbox({ file, files, onShow, onClose }: LightboxProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const at = file ? files.findIndex((f) => f.id === file.id) : -1;
  const steps: Steps = {
    index: Math.max(at, 0),
    total: at >= 0 ? files.length : 0,
    wrap: true,
    onShow: (index) => {
      const next = files[index];
      if (next) onShow(next);
    },
  };

  return (
    <RDialog.Root open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[70] bg-black/85 animate-fade" />
        <RDialog.Content
          ref={box}
          tabIndex={-1}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Start on the box, not on an arrow, whose tooltip would come up with it.
            e.preventDefault();
            box.current?.focus();
          }}
          // On a narrow window without a title bar (lib/window-inset.ts) a video's controls stay clear of the window's buttons.
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 outline-none max-sm:window-inset:pt-(--window-inset-height) sm:p-10"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          onKeyDown={(e) => onCarouselKey(e, steps)}
        >
          <VisuallyHidden.Root>
            <RDialog.Title>{file?.name}</RDialog.Title>
          </VisuallyHidden.Root>
          {/* Keyed, so the picture before does not stay up while the next one loads. */}
          {file && (isImage(file) || isVideo(file)) && <MediaFull key={file.id} file={file} className="rounded-md" />}
          <CarouselArrows {...steps} size="large" keys={{ previous: "←", next: "→" }} />
          <CarouselCount index={steps.index} total={steps.total} size="large" />
          <RDialog.Close aria-label={t("common.close")} className={cx("absolute top-3 right-3", round)}>
            <X className="size-5" />
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

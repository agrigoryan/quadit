import { FileText, Play, X } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { cx } from "@/lib/cx";
import { fileSize, isImage, isVideo } from "@/lib/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/lib/types";

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

/** One file over the whole screen. Escape or a click outside closes it. */
export function Lightbox({ file, onClose }: { file: FileRow | null; onClose: () => void }) {
  return (
    <RDialog.Root open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[70] bg-black/85 animate-fade" />
        <RDialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 outline-none sm:p-10"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <VisuallyHidden.Root>
            <RDialog.Title>{file?.name}</RDialog.Title>
          </VisuallyHidden.Root>
          {file && (isImage(file) || isVideo(file)) && <MediaFull file={file} className="rounded-md" />}
          <RDialog.Close
            aria-label={t("common.close")}
            className="absolute top-3 right-3 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X className="size-5" />
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

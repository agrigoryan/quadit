import { useLayoutEffect, useRef, useState } from "react";
import { Download, FileText, Play, X } from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { cx } from "@/lib/cx";
import { useFileText } from "@/data/file-text";
import { fileSize, isImage, isVideo, shownAs } from "@/data/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { CarouselArrows, CarouselCount, onCarouselKey, type Steps } from "@/ui/carousel";
import { Segmented } from "@/ui/segmented";
import { TextFile, tooLargeToRender } from "@/ui/text-file";

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

type MarkdownAs = "rendered" | "source";

/** Rendered or Source, for a Markdown file; held at Source for one too large to render. */
function MarkdownSwitch({
  file,
  value,
  onChange,
}: {
  file: FileRow;
  value: MarkdownAs;
  onChange: (as: MarkdownAs) => void;
}) {
  const read = useFileText(file);
  const tooLarge = !!read.data && tooLargeToRender(read.data.text);
  return (
    <Segmented
      label={t("viewer.showAs")}
      value={tooLarge ? "source" : value}
      onChange={onChange}
      disabled={tooLarge}
      options={[
        { value: "rendered", label: t("viewer.rendered") },
        { value: "source", label: t("viewer.source") },
      ]}
    />
  );
}

interface LightboxProps {
  /** The file shown; null while it is closed. */
  file: FileRow | null;
  /** The files it is one of, in their order: those it can show (shownAs in data/files.ts). */
  files: FileRow[];
  /** Asked for another of them. */
  onShow: (file: FileRow) => void;
  onClose: () => void;
}

/** The close button and the download link, in the look of the carousel's arrows. */
const dark = "rounded-full bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75 focus-visible:outline-white";
const round = cx("flex size-10 shrink-0 items-center justify-center", dark);

/**
 * One file over the whole screen, with its name and a link that downloads
 * it: a picture, a video, or a text file read and shown as text (Markdown
 * rendered, or its source at a choice). Escape or a click outside closes it.
 * When it is one of several, the arrows on its sides (below it on a phone)
 * and the arrow keys go to the ones beside it, and round from the last to
 * the first. In a text file the up and down keys scroll, and the left and
 * right ones keep moving: the text wraps, so they have nothing to scroll,
 * except in rendered Markdown wide enough (a table) to scroll sideways.
 */
export function Lightbox({ file, files, onShow, onClose }: LightboxProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const textBox = useRef<HTMLElement | null>(null);
  const [markdownAs, setMarkdownAs] = useState<MarkdownAs>("rendered");
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
  const shown = file ? shownAs(file) : null;
  const text = shown === "markdown" || shown === "text";

  // A text file shown, however it was come to, has the focus, so the keys
  // scroll it at once; each starts at its top.
  const fileId = file?.id;
  useLayoutEffect(() => {
    const box = textBox.current;
    if (!fileId || !box) return;
    box.scrollTop = 0;
    box.focus({ preventScroll: true });
  }, [fileId]);

  return (
    <RDialog.Root open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[70] bg-black/85 animate-fade" />
        <RDialog.Content
          ref={box}
          data-backdrop
          tabIndex={-1}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Start on the text, which the keys then scroll, or on the box: not on an arrow, whose tooltip would come up with it.
            e.preventDefault();
            (textBox.current ?? box.current)?.focus();
          }}
          className="fixed inset-0 z-[70] flex flex-col outline-none"
          // A click on the dark around the file, not on the file or a control.
          onClick={(e) => e.target instanceof HTMLElement && e.target.hasAttribute("data-backdrop") && onClose()}
          onKeyDown={(e) => onCarouselKey(e, steps)}
        >
          {/* In a window without a title bar (lib/window-inset.ts) the name stays clear of the window's buttons. */}
          <div data-backdrop className="flex items-center gap-2 p-3 window-inset:pl-(--window-inset-left)">
            <RDialog.Title className="min-w-0 flex-1 truncate text-sm font-medium text-white" title={file?.name}>
              {file?.name}
            </RDialog.Title>
            {file && shown === "markdown" && <MarkdownSwitch file={file} value={markdownAs} onChange={setMarkdownAs} />}
            {file && (
              <a
                href={file.url}
                download={file.name}
                className={cx(
                  "flex h-10 shrink-0 items-center gap-1.5 px-3 text-sm max-sm:w-10 max-sm:justify-center max-sm:px-0",
                  dark,
                )}
              >
                <Download className="size-4" aria-hidden />
                <span className="max-sm:sr-only">{t("viewer.download")}</span>
              </a>
            )}
            <RDialog.Close aria-label={t("common.close")} className={round}>
              <X className="size-5" />
            </RDialog.Close>
          </div>
          <div
            data-backdrop
            className={cx(
              "relative flex min-h-0 flex-1 items-center justify-center px-4 sm:px-16 sm:pb-10",
              steps.total > 1 ? "pb-16" : "pb-4",
            )}
          >
            {/* Keyed, so the picture before does not stay up while the next one loads. */}
            {file && (shown === "image" || shown === "video") && (
              <MediaFull key={file.id} file={file} className="rounded-md" />
            )}
            {file && text && (
              <section
                ref={textBox}
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- text that scrolls is reached with the keyboard
                tabIndex={0}
                aria-label={file.name}
                className="size-full max-w-4xl overflow-y-auto overscroll-contain rounded-md bg-surface text-ink shadow-pop"
              >
                <TextFile file={file} rendered={shown === "markdown" && markdownAs === "rendered"} />
              </section>
            )}
            {/* Over the sides of the stage; on a phone in a strip below it, off the text. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 sm:inset-y-0 sm:h-auto [&_button]:pointer-events-auto">
              <CarouselArrows {...steps} size="large" keys={{ previous: "←", next: "→" }} />
              <CarouselCount index={steps.index} total={steps.total} size="large" />
            </div>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

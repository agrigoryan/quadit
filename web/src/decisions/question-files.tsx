// The files on a question itself, shown above its options and laid out like
// them: pictures and videos side by side in boxes of one shape, anything else
// as a named link. A picture opens over the whole screen.

import { useState } from "react";
import { cx } from "@/lib/cx";
import { isMedia, isVideo } from "@/data/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { Lightbox } from "@/ui/media";
import { isSmallArt, mediaAspect, type OptionFile } from "@/decisions/data";
import { OptionDocs, thumbOf } from "@/decisions/option-media";

/** The columns of the pictures, as the options' cards have them; one picture alone stays modest. */
function columns(count: number): string {
  if (count === 1) return "grid-cols-1 sm:max-w-md";
  return count === 2 || count === 4 ? "grid-cols-2" : "@max-lg:grid-cols-2 @lg:grid-cols-3";
}

/** One picture or video of the question, in a box of the given shape. */
function QuestionMedia({ file, aspect, onOpen }: { file: OptionFile; aspect: number; onOpen: () => void }) {
  return (
    <li className="min-w-0 overflow-hidden rounded-lg border border-line bg-sunken" style={{ aspectRatio: aspect }}>
      {isVideo(file) ? (
        <video
          src={file.url}
          poster={file.preview_url}
          controls
          playsInline
          preload="metadata"
          aria-label={file.name}
          className="size-full object-contain"
        />
      ) : (
        <button
          type="button"
          aria-label={t("detail.files.open", { name: file.name })}
          onClick={onOpen}
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
            style={isSmallArt(file.width, file.height) ? { imageRendering: "pixelated" } : undefined}
          />
        </button>
      )}
    </li>
  );
}

export function QuestionFiles({ files }: { files: OptionFile[] }) {
  const [shown, setShown] = useState<FileRow | null>(null);
  if (files.length === 0) return null;
  const media = files.filter(isMedia);
  const docs = files.filter((f) => !isMedia(f));
  const aspect = mediaAspect(media);

  return (
    <div className="mt-3">
      {media.length > 0 && (
        <ul aria-label={t("detail.files")} className={cx("grid gap-3", columns(media.length))}>
          {media.map((file) => (
            <QuestionMedia key={file.attachmentId} file={file} aspect={aspect} onOpen={() => setShown(file)} />
          ))}
        </ul>
      )}
      <OptionDocs files={docs} />
      <Lightbox file={shown} files={media} onShow={setShown} onClose={() => setShown(null)} />
    </div>
  );
}

// Files as a grid of thumbnails: pictures, videos and text open over the
// whole screen, with the others of the grid a step away; anything else
// downloads. Used for the task's own files and for the files of a comment.

import { useState } from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";
import { shownAs } from "@/data/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import type { Attached } from "@/detail/data";
import type { PendingUpload } from "@/detail/uploads";
import { Lightbox, MediaThumb } from "@/ui/media";
import { Spinner } from "@/ui/spinner";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  files: Attached[];
  /** Files still uploading: drawn as waiting tiles after the others. */
  pending?: PendingUpload[];
  canRemove?: (attachment: Attached) => boolean;
  onRemove?: (attachment: Attached) => void;
  /** Smaller tiles, for the files of a comment. */
  small?: boolean;
  className?: string;
}

const tile = "relative aspect-[4/3] overflow-hidden rounded-md border border-line bg-sunken";

export function FileGrid({ files, pending = [], canRemove, onRemove, small, className }: Props) {
  const [shown, setShown] = useState<FileRow | null>(null);
  if (files.length === 0 && pending.length === 0) return null;

  return (
    <>
      <ul className={cx("grid gap-2", small ? "grid-cols-3 sm:grid-cols-5" : "grid-cols-3 sm:grid-cols-4", className)}>
        {files.map((a) => (
          <li key={a.id} className={cx("group", tile)}>
            {shownAs(a.file) ? (
              <button
                type="button"
                aria-label={t("detail.files.open", { name: a.file.name })}
                onClick={() => setShown(a.file)}
                className="block size-full"
              >
                <MediaThumb file={a.file} className="size-full" />
              </button>
            ) : (
              <a
                href={a.file.url}
                download={a.file.name}
                aria-label={t("detail.files.download", { name: a.file.name })}
                className="block size-full hover:bg-hover"
              >
                <MediaThumb file={a.file} className="size-full bg-transparent" />
              </a>
            )}
            {onRemove && canRemove?.(a) && (
              <Tooltip label={t("detail.files.remove", { name: a.file.name })}>
                <button
                  type="button"
                  aria-label={t("detail.files.remove", { name: a.file.name })}
                  onClick={() => onRemove(a)}
                  className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-sm bg-surface text-ink-2 opacity-0 shadow-pop group-hover:opacity-100 hover:text-ink focus-visible:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </Tooltip>
            )}
          </li>
        ))}
        {pending.map((p) => (
          <li key={p.id} className={cx("flex flex-col items-center justify-center gap-1.5 p-2 text-center", tile)}>
            <Spinner label={t("detail.files.uploading", { name: p.name })} />
            {/* How far along it is, or why it has stopped. */}
            <span className="text-2xs font-medium text-ink-2 tnum" aria-live="polite">
              {p.waiting ? t("upload.waitingOne") : t("detail.files.percent", { n: p.percent ?? 0 })}
            </span>
            <span className="line-clamp-1 text-2xs break-all text-ink-3">{p.name}</span>
          </li>
        ))}
      </ul>
      <Lightbox
        file={shown}
        files={files.filter((a) => shownAs(a.file)).map((a) => a.file)}
        onShow={setShown}
        onClose={() => setShown(null)}
      />
    </>
  );
}

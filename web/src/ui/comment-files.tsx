// What a comment box has for files, on a task and on a page: the paperclip
// that picks them, the box taking those dropped on it, and the chips of the
// files waiting to be sent. Uploading and sending them is data/comment-files.ts;
// pasted files come in through ui/mention-textarea.tsx's onFiles.

import { type DragEvent, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { carriesFiles } from "@/data/files";
import type { WaitingFile } from "@/data/comment-files";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { IconButton, type IconButtonProps } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

/** The paperclip: picks files from the computer. */
export function AttachButton({
  onFiles,
  size,
  className,
}: {
  onFiles: (files: File[]) => void;
  size?: IconButtonProps["size"];
  className?: string;
}) {
  const chooser = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={chooser}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <IconButton
        label={t("comment.attach")}
        size={size}
        className={className}
        onClick={() => chooser.current?.click()}
      >
        <Paperclip className={size === "sm" ? "size-3.5" : "size-4"} />
      </IconButton>
    </>
  );
}

/**
 * Makes a comment box take files dropped on it: spread `drop` on the box,
 * and light it while `over`. A drag of text or of a link is left to the
 * text box.
 */
export function useDropFiles(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const held = (e: DragEvent) => {
    if (!carriesFiles(e)) return false;
    e.preventDefault();
    // A box inside something that takes files too (the task panel) keeps them for itself.
    e.stopPropagation();
    return true;
  };
  return {
    over,
    drop: {
      onDragOver: (e: DragEvent) => {
        if (held(e)) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        if (!held(e)) return;
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      },
    },
  };
}

/** The files given with a comment not sent yet, as chips: a spinner while one uploads, and a button to take it off. */
export function WaitingFiles({
  files,
  onRemove,
  className,
}: {
  files: WaitingFile[];
  onRemove: (key: string) => void;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <ul className={cx("flex flex-wrap gap-1.5", className)}>
      {files.map((f) => (
        <li
          key={f.key}
          className="flex h-6 max-w-full items-center gap-1.5 rounded-sm border border-line bg-sunken pr-0.5 pl-1.5 text-xs text-ink-2 max-md:h-8"
        >
          {f.file ? (
            <Paperclip className="size-3 shrink-0" aria-hidden />
          ) : (
            <Spinner className="size-3" label={t("detail.files.uploading", { name: f.name })} />
          )}
          <span className="max-w-40 truncate">{f.name}</span>
          <button
            type="button"
            aria-label={t("comment.removeFile", { name: f.name })}
            onClick={() => onRemove(f.key)}
            className="flex size-5 items-center justify-center rounded-xs text-ink-3 hover:bg-hover hover:text-ink max-md:size-7"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

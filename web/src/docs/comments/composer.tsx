import { ArrowUp, AtSign, X } from "lucide-react";
import { type Ref, useRef, useState } from "react";
import { readyFiles, uploadWaiting, type WaitingFile } from "@/data/comment-files";
import { MOD } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { IconButton } from "@/ui/button";
import { AttachButton, useDropFiles, WaitingFiles } from "@/ui/comment-files";
import { MentionTextarea, startMention } from "@/ui/mention-textarea";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  placeholder: string;
  /** What the send arrow is called. */
  submitLabel: string;
  /** What is written, trimmed, and the files given with it, all uploaded. */
  onSubmit: (comment: { body: string; files: FileRow[] }) => void;
  /** Puts away the box of a new thread: Escape, or its own button. */
  onCancel?: () => void;
  autoFocus?: boolean;
  /** The text box, for whoever puts the cursor in it from outside. */
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * A small box for a comment or a reply: Markdown, @ to mention, files by the
 * paperclip, a paste or a drop, and Cmd/Ctrl-Enter or the arrow to send.
 * Its buttons show while it is in use; idle, it is one line.
 */
export function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus, ref }: Props) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<WaitingFile[]>([]);
  const [active, setActive] = useState(!!autoFocus);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const addFiles = (picked: File[]) => uploadWaiting(picked, setFiles);
  const { over, drop } = useDropFiles(addFiles);
  const ready = readyFiles(files);
  const canSend = body.trim() !== "" && !ready.uploading;
  const send = () => {
    if (!canSend) return;
    onSubmit({ body: body.trim(), files: ready.files });
    setBody("");
    setFiles([]);
    setActive(false);
  };
  const inUse = active || body !== "" || files.length > 0;

  return (
    <div
      {...drop}
      className={cx(
        "rounded-lg border bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25",
        over ? "border-accent ring-2 ring-accent/25" : "border-line-strong",
      )}
    >
      <MentionTextarea
        bare
        ref={(el) => {
          box.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        value={body}
        onChange={setBody}
        onSubmit={send}
        onFiles={addFiles}
        autoFocus={autoFocus}
        rows={inUse ? 2 : 1}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setActive(true)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // A box that can be put away is; one that stays is left, with what was typed kept.
          if (onCancel) {
            e.stopPropagation();
            onCancel();
          } else e.currentTarget.blur();
        }}
        className="block px-2.5 py-1.5 text-sm leading-5"
      />
      <WaitingFiles
        files={files}
        onRemove={(key) => setFiles((list) => list.filter((f) => f.key !== key))}
        className="px-2.5 pb-1.5"
      />
      {inUse && (
        <div className="flex items-center justify-end gap-0.5 px-1 pb-1">
          {onCancel && (
            <IconButton size="sm" label={t("common.cancel")} className="mr-auto max-md:size-9" onClick={onCancel}>
              <X className="size-3.5" />
            </IconButton>
          )}
          <AttachButton size="sm" onFiles={addFiles} className="max-md:size-9" />
          <IconButton
            size="sm"
            label={t("comment.mention")}
            className="max-md:size-9"
            // The cursor stays where it is in the text, for the "@" to go there.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => box.current && startMention(box.current)}
          >
            <AtSign className="size-3.5" />
          </IconButton>
          <Tooltip label={submitLabel} hint={`${MOD} Enter`}>
            <button
              type="button"
              aria-label={submitLabel}
              disabled={!canSend}
              onClick={send}
              className={cx(
                "ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors max-md:size-9",
                canSend ? "bg-accent text-accent-ink hover:bg-accent-hover" : "bg-sunken text-ink-3",
              )}
            >
              <ArrowUp className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

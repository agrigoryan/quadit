import { X } from "lucide-react";
import { type Ref, useRef, useState } from "react";
import { readyFiles } from "@/data/comment-files";
import { addDraftFiles, dropDraft, editDraft, EMPTY_DRAFT, useCommentDrafts } from "@/docs/comments/drafts";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { IconButton } from "@/ui/button";
import { CommentButtons } from "@/ui/comment-buttons";
import { useDropFiles, WaitingFiles } from "@/ui/comment-files";
import { MentionTextarea } from "@/ui/mention-textarea";

interface Props {
  /** What the box writes, as drafts.ts keys it: what is typed and given stays with that, box or no box. */
  draft: string;
  /** The page's project: its tasks and pages are offered first after @ and [[, and its pages are named so. */
  projectId?: string;
  placeholder: string;
  /** What the send arrow is called. */
  submitLabel: string;
  /** What is written, trimmed, and the files given with it, all uploaded. */
  onSubmit: (comment: { body: string; files: FileRow[] }) => void;
  /** Puts the box away, the draft kept: Escape. Without it, Escape leaves the box. */
  onClose?: () => void;
  /** The box's own cancel button: the draft is thrown away. Without it, no such button. */
  onCancel?: () => void;
  autoFocus?: boolean;
  /** The text box, for whoever puts the cursor in it from outside. */
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * A small box for a comment or a reply: Markdown, @ to mention, files by the
 * paperclip, a paste or a drop, and Cmd/Ctrl-Enter or the arrow to send.
 * Its buttons show while it is in use; idle, it is one line. What is in it
 * is its target's draft (drafts.ts).
 */
export function Composer({
  draft,
  projectId,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
  onCancel,
  autoFocus,
  ref,
}: Props) {
  const { body, files } = useCommentDrafts((s) => s.drafts[draft]) ?? EMPTY_DRAFT;
  const [active, setActive] = useState(!!autoFocus);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const addFiles = (picked: File[]) => addDraftFiles(draft, picked);
  const { over, drop } = useDropFiles(addFiles);
  const ready = readyFiles(files);
  const canSend = body.trim() !== "" && !ready.uploading;
  const send = () => {
    if (!canSend) return;
    onSubmit({ body: body.trim(), files: ready.files });
    dropDraft(draft);
    setActive(false);
  };
  const cancel =
    onCancel &&
    (() => {
      dropDraft(draft);
      onCancel();
    });
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
        projectId={projectId}
        ref={(el) => {
          box.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        value={body}
        onChange={(text) => editDraft(draft, (d) => ({ ...d, body: text }))}
        onSubmit={send}
        onFiles={addFiles}
        autoFocus={autoFocus}
        rows={inUse ? 2 : 1}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setActive(true)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // A box that can be put away is; one that stays is left. Either way, what was typed is kept.
          if (onClose) {
            e.stopPropagation();
            onClose();
          } else e.currentTarget.blur();
        }}
        className="block px-2.5 py-1.5 text-sm leading-5"
      />
      <WaitingFiles
        files={files}
        onRemove={(key) => editDraft(draft, (d) => ({ ...d, files: d.files.filter((f) => f.key !== key) }))}
        className="px-2.5 pb-1.5"
      />
      {inUse && (
        <div className="flex items-center justify-end gap-0.5 px-1 pb-1">
          {cancel && (
            <IconButton size="sm" label={t("common.cancel")} className="mr-auto max-md:size-9" onClick={cancel}>
              <X className="size-3.5" />
            </IconButton>
          )}
          <CommentButtons box={box} onFiles={addFiles} sendLabel={submitLabel} canSend={canSend} onSend={send} />
        </div>
      )}
    </div>
  );
}

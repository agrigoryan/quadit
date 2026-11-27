// The buttons at the end of a comment box, on a task and on a page alike:
// the paperclip, @ to mention someone or something, and the round arrow
// that sends (Cmd/Ctrl+Enter does too, in ui/mention-textarea.tsx).

import type { RefObject } from "react";
import { ArrowUp, AtSign } from "lucide-react";
import { MOD } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { IconButton } from "@/ui/button";
import { AttachButton } from "@/ui/comment-files";
import { startMention } from "@/ui/mention-textarea";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  /** The comment's text box, where @ starts a mention. */
  box: RefObject<HTMLTextAreaElement | null>;
  onFiles: (files: File[]) => void;
  /** What the send arrow is called. */
  sendLabel: string;
  canSend: boolean;
  onSend: () => void;
}

export function CommentButtons({ box, onFiles, sendLabel, canSend, onSend }: Props) {
  return (
    <>
      <AttachButton size="sm" onFiles={onFiles} className="max-md:size-9" />
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
      <Tooltip label={sendLabel} hint={`${MOD} Enter`}>
        <button
          type="button"
          aria-label={sendLabel}
          disabled={!canSend}
          onClick={onSend}
          className={cx(
            "ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors max-md:size-9",
            canSend ? "bg-accent text-accent-ink hover:bg-accent-hover" : "bg-sunken text-ink-3",
          )}
        >
          <ArrowUp className="size-3.5" />
        </button>
      </Tooltip>
    </>
  );
}

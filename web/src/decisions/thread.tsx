// The comment thread of one option (or of a decision as a whole): a quiet
// toggle that shows the count, and the thread itself with a one-line box.

import { useState } from "react";
import { MessageSquare, SendHorizontal } from "lucide-react";
import { cx } from "@/lib/cx";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useMember } from "@/lib/selectors";
import { exact } from "@/lib/time";
import type { Comment, Decision } from "@/lib/types";
import { Avatar } from "@/ui/avatar";
import { IconButton } from "@/ui/button";
import { Markdown } from "@/ui/markdown";
import { MentionTextarea } from "@/ui/mention-textarea";
import { addComment } from "@/decisions/actions";
import { nameOf, useThread } from "@/decisions/data";
import { Ago } from "@/ui/ago";

interface Subject {
  decision: Decision;
  /** Leave out for the thread on the decision as a whole. */
  optionId?: string;
}

const useSubjectThread = ({ decision, optionId }: Subject) =>
  useThread(optionId ? "decision_option" : "decision", optionId ?? decision.id);

interface ToggleProps extends Subject {
  open: boolean;
  onToggle: () => void;
  className?: string;
}

/** "2 comments" or "Comment": opens and closes the thread. */
export function ThreadToggle({ open, onToggle, className, ...subject }: ToggleProps) {
  const count = useSubjectThread(subject).length;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink max-sm:h-9",
        count > 0 ? "font-medium text-ink" : "text-ink-2",
        className,
      )}
    >
      <MessageSquare className="size-3.5" aria-hidden />
      {count > 0 ? t("decision.comments", { n: count }) : t("decision.comment")}
    </button>
  );
}

function Entry({ comment }: { comment: Comment }) {
  const author = useMember(comment.author_id);
  return (
    <li className="flex gap-2">
      <Avatar member={author} size="xs" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-xs">
          <span className="truncate font-medium text-ink">{nameOf(author, t("common.someone"))}</span>
          <time className="shrink-0 text-ink-3" title={exact(comment.created_at)}>
            <Ago ms={comment.created_at} />
          </time>
        </p>
        <Markdown text={comment.body} tight />
      </div>
    </li>
  );
}

interface BodyProps extends Subject {
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
  /** Shows the comments without the box to add one. */
  readOnly?: boolean;
}

/** The comments and the box to add one. Cmd/Ctrl-Enter sends. */
export function ThreadBody({ placeholder, autoFocus, className, readOnly, ...subject }: BodyProps) {
  const comments = useSubjectThread(subject);
  const [draft, setDraft] = useState("");

  function submit() {
    const body = draft.trim();
    if (!body) return;
    addComment(subject.decision, subject.optionId, body);
    setDraft("");
  }

  return (
    <div className={cx("flex flex-col gap-2.5", className)}>
      {comments.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {comments.map((c) => (
            <Entry key={c.id} comment={c} />
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex items-end gap-1">
          <div className="min-w-0 flex-1">
            <MentionTextarea
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              rows={1}
              autoFocus={autoFocus}
              placeholder={placeholder}
              aria-label={placeholder}
              className="min-h-8 max-sm:min-h-10 max-sm:py-2 max-sm:text-base"
            />
          </div>
          <IconButton
            label={t("decision.commentSend")}
            hint={`${MOD} ↵`}
            disabled={!draft.trim()}
            onClick={submit}
            className="mb-0.5 max-sm:size-10"
          >
            <SendHorizontal className="size-4" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

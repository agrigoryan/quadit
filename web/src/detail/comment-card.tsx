// One comment thread in the timeline: the comment, its replies one level
// deep, and a place to reply. Your own comments can be edited and deleted.

import { memo, useState } from "react";
import { MoreHorizontal, Pencil, Reply, Trash2 } from "lucide-react";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import { exact } from "@/lib/time";
import type { Comment, Task } from "@/lib/types";
import { caretToEnd } from "@/detail/bits";
import { createComment, deleteComment, updateComment } from "@/detail/comment-actions";
import type { Attached } from "@/detail/data";
import { FileGrid } from "@/detail/file-grid";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Markdown } from "@/ui/markdown";
import { MentionTextarea } from "@/ui/mention-textarea";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Tooltip } from "@/ui/tooltip";
import { Ago } from "@/ui/ago";

/** A time as "5m", with the exact moment on hover. */
export function When({ at }: { at: number }) {
  return (
    <Tooltip label={exact(at)} side="top">
      <time dateTime={new Date(at).toISOString()} className="shrink-0 text-xs whitespace-nowrap text-ink-3">
        <Ago ms={at} />
      </time>
    </Tooltip>
  );
}

interface BoxProps {
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

/** A small text box with its two buttons: used to edit a comment and to reply. */
function SmallComposer({ label, initial = "", submitLabel, onSubmit, onCancel }: BoxProps) {
  const [body, setBody] = useState(initial);
  const submit = () => body.trim() && onSubmit(body.trim());
  return (
    <div>
      <MentionTextarea
        autoFocus
        aria-label={label}
        placeholder={label}
        value={body}
        onChange={setBody}
        onSubmit={submit}
        onFocus={caretToEnd}
        className="min-h-16 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" className="max-md:h-9" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Tooltip label={`${MOD} Enter`}>
          <Button variant="primary" size="sm" className="max-md:h-9" disabled={!body.trim()} onClick={submit}>
            {submitLabel}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

const evidenceFields = [
  ["checked", "comment.evidence.checked"],
  ["measured", "comment.evidence.measured"],
  ["not_verified", "comment.evidence.notVerified"],
] as const;

interface EntryProps {
  comment: Comment;
  files: Attached[];
  readOnly: boolean;
  onReply?: () => void;
}

/** One comment or reply: who, when, what they wrote, and what they attached. */
function Entry({ comment, files, readOnly, onReply }: EntryProps) {
  const me = useMe();
  const author = useMember(comment.author_id);
  const [editing, setEditing] = useState(false);
  const mine = comment.author_id === me.user_id;
  const canDelete = mine || me.role !== "member";
  const evidence = evidenceFields.filter(([field]) => comment.evidence?.[field]);

  return (
    <div className="px-3 py-2.5">
      <div className="flex h-6 items-center gap-2">
        <Avatar member={author} size="sm" />
        <span className="min-w-0 truncate text-sm font-medium">{author?.name ?? t("common.someone")}</span>
        {comment.kind === "result" && <Badge tone="ok">{t("comment.result")}</Badge>}
        <When at={comment.created_at} />
        {!!comment.edited_at && <span className="shrink-0 text-xs text-ink-3">{t("comment.edited")}</span>}
        <span className="flex-1" />
        {!readOnly && onReply && (
          <IconButton label={t("comment.reply")} size="sm" className="max-md:size-9" onClick={onReply}>
            <Reply className="size-3.5" />
          </IconButton>
        )}
        {!readOnly && canDelete && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={t("comment.actions")} size="sm" className="max-md:size-9">
                <MoreHorizontal className="size-3.5" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              {mine && (
                <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                  {t("common.edit")}
                </MenuItem>
              )}
              <MenuItem danger icon={<Trash2 />} onSelect={() => deleteComment(comment)}>
                {t("comment.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>

      <div className="mt-1 pl-7">
        {editing ? (
          <SmallComposer
            label={t("comment.editLabel")}
            initial={comment.body}
            submitLabel={t("common.save")}
            onCancel={() => setEditing(false)}
            onSubmit={(body) => {
              if (body !== comment.body) updateComment(comment, body);
              setEditing(false);
            }}
          />
        ) : (
          <Markdown text={comment.body} tight />
        )}
        {evidence.length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-l-2 border-line pl-2.5 text-xs">
            {evidence.map(([field, label]) => (
              <div key={field} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-ink-3">{t(label)}</dt>
                <dd className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">{comment.evidence?.[field]}</dd>
              </div>
            ))}
          </dl>
        )}
        <FileGrid files={files} small className="mt-2" />
      </div>
    </div>
  );
}

interface Props {
  task: Task;
  comment: Comment;
  replies: Comment[];
  /** Files by the comment they are on. */
  files: Dict<Attached[]>;
}

const NO_FILES: Attached[] = [];

export const CommentCard = memo(function CommentCard({ task, comment, replies, files }: Props) {
  const [replying, setReplying] = useState(false);
  const readOnly = !!task.deleted_at;
  return (
    <article className="rounded-lg border border-line">
      <Entry comment={comment} files={files[comment.id] ?? NO_FILES} readOnly={readOnly} onReply={() => setReplying(true)} />
      {replies.map((reply) => (
        <div key={reply.id} className="ml-7 border-t border-line">
          <Entry comment={reply} files={files[reply.id] ?? NO_FILES} readOnly={readOnly} />
        </div>
      ))}
      {replying && (
        <div className="ml-7 border-t border-line px-3 py-2.5">
          <SmallComposer
            label={t("comment.replyPlaceholder")}
            submitLabel={t("comment.sendReply")}
            onCancel={() => setReplying(false)}
            onSubmit={(body) => {
              createComment({ task, body, parentId: comment.id });
              setReplying(false);
            }}
          />
        </div>
      )}
    </article>
  );
});

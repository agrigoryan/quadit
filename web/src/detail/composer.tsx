// The comment box at the end of the timeline. Files can be attached by
// button, paste or drop, and the task can be handed to someone in the same
// send. The draft survives closing the panel until it is sent. Escape
// leaves the box with the draft kept, so the next key is the task's (Escape
// again closes it); Ctrl+M comes back to it (detail/comment-box.ts).

import { CircleSlash, CornerDownRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { MOD } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { mayBeGivenWork } from "@/data/access";
import { useMe, useMember, useMembers } from "@/data/selectors";
import { readyFiles } from "@/data/comment-files";
import type { Task } from "@/types/core";
import { addDraftFiles, createComment, editDraft, EMPTY_DRAFT, useDrafts } from "@/detail/comment-actions";
import { nameOf } from "@/detail/data";
import { memberItems } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { AttachButton, useDropFiles, WaitingFiles } from "@/ui/comment-files";
import { MentionTextarea } from "@/ui/mention-textarea";
import { Picker } from "@/ui/picker";
import { Tooltip } from "@/ui/tooltip";

const NOBODY = "none";

export function Composer({ task }: { task: Task }) {
  const me = useMe();
  // The task may be handed to those who may read its project.
  const members = useMembers().filter((m) => mayBeGivenWork(m, task.project_id));
  const draft = useDrafts((s) => s.drafts[task.id]) ?? EMPTY_DRAFT;
  const handTo = useMember(draft.handTo ?? undefined);
  const { over, drop } = useDropFiles((files) => addDraftFiles(task.id, files));

  const { files, uploading } = readyFiles(draft.files);
  const canSend = draft.body.trim() !== "" && !uploading;

  function submit() {
    if (!canSend) return;
    createComment({ task, body: draft.body.trim(), files, handTo: draft.handTo });
    editDraft(task.id, () => EMPTY_DRAFT);
  }

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
        aria-label={t("comment.label")}
        placeholder={t("comment.placeholder")}
        value={draft.body}
        projectId={task.project_id}
        onChange={(body) => editDraft(task.id, (d) => ({ ...d, body }))}
        onSubmit={submit}
        onFiles={(files) => addDraftFiles(task.id, files)}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        data-comment-box
        className="block min-h-16 px-3 pt-2.5 pb-1 text-sm leading-[1.375rem]"
      />

      <WaitingFiles
        files={draft.files}
        onRemove={(key) => editDraft(task.id, (d) => ({ ...d, files: d.files.filter((f) => f.key !== key) }))}
        className="px-3 pb-1.5"
      />

      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <AttachButton onFiles={(files) => addDraftFiles(task.id, files)} className="max-md:size-10" />
        <Picker
          label={t("comment.handTo")}
          placeholder={t("comment.handTo")}
          value={draft.handTo ?? NOBODY}
          items={[
            {
              id: NOBODY,
              label: t("comment.handToNobody"),
              icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden />,
            },
            ...memberItems(members, me.user_id),
          ]}
          onPick={(id) => editDraft(task.id, (d) => ({ ...d, handTo: id === NOBODY ? null : id }))}
        >
          <Button variant="ghost" className={cx("min-w-0 max-md:h-10", handTo && "text-ink")}>
            {handTo ? <Avatar member={handTo} size="xs" /> : <CornerDownRight className="size-3.5" aria-hidden />}
            <span className="truncate">
              {!handTo
                ? t("comment.handTo")
                : handTo.user_id === me.user_id
                  ? t("comment.willWaitOnYou")
                  : t("comment.willWaitOn", { name: nameOf(handTo) })}
            </span>
          </Button>
        </Picker>
        <span className="flex-1" />
        <Tooltip label={`${MOD} Enter`}>
          <Button variant="primary" className="max-md:h-10 max-md:px-4" disabled={!canSend} onClick={submit}>
            {t("comment.send")}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

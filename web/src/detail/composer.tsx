// The comment box at the end of the timeline. Files can be attached by
// button, paste or drop, and the task can be handed to someone in the same
// send. The draft survives closing the panel until it is sent. Escape
// leaves the box with the draft kept, so the next key is the task's (Escape
// again closes it); Ctrl+M comes back to it (detail/comment-box.ts).

import { useRef, useState } from "react";
import { CircleSlash, CornerDownRight, Paperclip, X } from "lucide-react";
import { cx } from "@/lib/cx";
import { MOD } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { mayBeGivenWork } from "@/data/access";
import { useMe, useMember, useMembers } from "@/data/selectors";
import type { FileRow, Task } from "@/types/core";
import { addDraftFiles, createComment, editDraft, EMPTY_DRAFT, useDrafts } from "@/detail/comment-actions";
import { nameOf } from "@/detail/data";
import { carriesFiles } from "@/detail/uploads";
import { memberItems } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button, IconButton } from "@/ui/button";
import { MentionTextarea } from "@/ui/mention-textarea";
import { Picker } from "@/ui/picker";
import { Spinner } from "@/ui/spinner";
import { Tooltip } from "@/ui/tooltip";

const NOBODY = "none";

export function Composer({ task }: { task: Task }) {
  const me = useMe();
  // The task may be handed to those who may read its project.
  const members = useMembers().filter((m) => mayBeGivenWork(m, task.project_id));
  const draft = useDrafts((s) => s.drafts[task.id]) ?? EMPTY_DRAFT;
  const handTo = useMember(draft.handTo ?? undefined);
  const chooser = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const uploading = draft.files.some((f) => !f.file);
  const canSend = draft.body.trim() !== "" && !uploading;

  function submit() {
    if (!canSend) return;
    createComment({
      task,
      body: draft.body.trim(),
      files: draft.files.map((f) => f.file).filter((f): f is FileRow => !!f),
      handTo: draft.handTo,
    });
    editDraft(task.id, () => EMPTY_DRAFT);
  }

  return (
    <div
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        addDraftFiles(task.id, [...e.dataTransfer.files]);
      }}
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

      {draft.files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 pb-1.5">
          {draft.files.map((f) => (
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
                onClick={() => editDraft(task.id, (d) => ({ ...d, files: d.files.filter((x) => x.key !== f.key) }))}
                className="flex size-5 items-center justify-center rounded-xs text-ink-3 hover:bg-hover hover:text-ink max-md:size-7"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <input
          ref={chooser}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addDraftFiles(task.id, [...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <IconButton label={t("comment.attach")} className="max-md:size-10" onClick={() => chooser.current?.click()}>
          <Paperclip className="size-4" />
        </IconButton>
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

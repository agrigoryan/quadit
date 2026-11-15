// The task's title and description, both edited in place.

import { type MouseEvent, useState } from "react";
import { Pencil } from "lucide-react";
import { cx } from "@/lib/cx";
import { MOD } from "@/hooks/hotkeys";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import type { Task } from "@/types/core";
import { caretToEnd } from "@/detail/caret-to-end";
import { setDescription, setTitle } from "@/tasks/actions";
import { Button, IconButton } from "@/ui/button";
import { Textarea } from "@/ui/input";
import { Markdown } from "@/ui/markdown";
import { MentionTextarea } from "@/ui/mention-textarea";

/**
 * The title is always a text box that looks like a heading: click and type.
 * Enter saves, Escape puts the old title back, and it can never be left empty.
 */
export function EditableTitle({ task, large }: { task: Task; large?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const can = useCan();

  // Leaving the box saves; Enter leaves it.
  function save() {
    const next = (draft ?? task.title).replace(/\s+/g, " ").trim();
    if (next && next !== task.title) setTitle([task], next);
    setDraft(null);
  }

  return (
    <Textarea
      bare
      autoGrow
      rows={1}
      aria-label={t("detail.title")}
      readOnly={!can.editTask(task)}
      value={draft ?? task.title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== null && save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
      className={cx(
        "-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-lg font-semibold tracking-tight hover:bg-hover/60 focus:bg-transparent focus:ring-2 focus:ring-accent/25",
        // On the task's own page the title is the page's heading.
        large && "lg:text-2xl",
      )}
    />
  );
}

/** Two grey lines where the description will be, so nothing jumps when it loads. */
function DescriptionSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 py-1.5">
      <span className="h-3 w-4/5 rounded-xs bg-sunken" />
      <span className="h-3 w-3/5 rounded-xs bg-sunken" />
    </div>
  );
}

/**
 * The description as rendered Markdown. A click (not on a link, not while
 * selecting text) or the pencil turns it into a text box.
 */
export function Description({ task, loading }: { task: Task; loading: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = task.description ?? "";
  const can = useCan();
  const readOnly = !can.editTask(task);

  // Leaving the task for the trash ends the edit.
  if (readOnly && draft !== null) setDraft(null);

  function save() {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== text.trim()) setDescription([task], next || null);
    setDraft(null);
  }

  function clickToEdit(e: MouseEvent) {
    if (readOnly) return;
    if ((e.target as HTMLElement).closest("a, input, button")) return;
    if (window.getSelection()?.toString()) return;
    setDraft(text);
  }

  if (draft !== null) {
    return (
      <div className="mt-2">
        <MentionTextarea
          autoFocus
          aria-label={t("detail.description")}
          value={draft}
          onChange={setDraft}
          onSubmit={save}
          onFocus={caretToEnd}
          placeholder={t("detail.descriptionPlaceholder")}
          className="min-h-28 text-sm leading-6"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3 max-sm:invisible">
            {t("detail.saveHint", { mod: MOD })}
          </span>
          <Button variant="ghost" className="max-md:h-9" onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" className="max-md:h-9" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  if (!text) {
    if (loading)
      return (
        <div className="mt-2">
          <DescriptionSkeleton />
        </div>
      );
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={() => setDraft("")}
        className="-mx-1.5 mt-1 flex h-8 w-[calc(100%+0.75rem)] items-center rounded-md px-1.5 text-left text-sm text-ink-3 hover:bg-hover hover:text-ink-2 max-md:h-10"
      >
        {t("detail.addDescription")}
      </button>
    );
  }

  return (
    <div className="group relative mt-2">
      {/* The pencil is the keyboard's way in; the click is a shortcut for the mouse. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see above */}
      <div onClick={clickToEdit} className={readOnly ? undefined : "cursor-text"}>
        <Markdown text={text} />
      </div>
      {!readOnly && (
        <IconButton
          label={t("detail.editDescription")}
          size="sm"
          variant="secondary"
          onClick={() => setDraft(text)}
          className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Pencil className="size-3" />
        </IconButton>
      )}
    </div>
  );
}

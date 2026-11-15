// An epic's description: Markdown, edited in place.

import { useState } from "react";
import { Pencil } from "lucide-react";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import type { Epic } from "@/types/core";
import { sendOnModEnter } from "@/lib/mod-enter";
import { updateEpic } from "@/insights/plan/actions";
import { Button, IconButton } from "@/ui/button";
import { Textarea } from "@/ui/input";
import { Markdown } from "@/ui/markdown";

/** readOnly: shown, not edited (the member may not change this project). */
export function EpicDescription({ epic, readOnly }: { epic: Epic; readOnly: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = epic.description ?? "";

  function save() {
    if (draft !== null && draft !== text) updateEpic(epic, { description: draft });
    setDraft(null);
  }

  if (draft !== null) {
    return (
      <div className="mt-2 max-w-3xl">
        <Textarea
          autoFocus
          autoGrow
          aria-label={t("epic.description")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("epic.descriptionPlaceholder")}
          className="min-h-24 leading-6"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            } else sendOnModEnter(e, save);
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3 max-sm:invisible">
            {t("detail.saveHint", { mod: MOD })}
          </span>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  if (!text) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={() => setDraft("")}
        className="-mx-1.5 mt-1 flex h-8 w-full max-w-3xl items-center rounded-md px-1.5 text-left text-sm text-ink-3 hover:bg-hover hover:text-ink-2"
      >
        {t("epic.addDescription")}
      </button>
    );
  }

  return (
    <div className="group relative mt-2 max-w-3xl pr-8">
      <Markdown text={text} />
      {!readOnly && (
        <IconButton
          label={t("epic.editDescription")}
          size="sm"
          variant="secondary"
          onClick={() => setDraft(text)}
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Pencil className="size-3" />
        </IconButton>
      )}
    </div>
  );
}

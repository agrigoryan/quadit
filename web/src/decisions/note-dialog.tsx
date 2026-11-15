// The small dialog that asks for a note before an answer is sent: what to
// change, why none of the options fit, what is unclear. It also serves as
// the plain "are you sure" before a question is deleted.

import { useId, useState } from "react";
import { t } from "@/lib/i18n";
import { MOD } from "@/lib/hotkeys";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Textarea } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { useReturnFocus } from "@/decisions/data";
import { sendOnModEnter } from "@/lib/mod-enter";

export interface NotePrompt {
  title: string;
  description?: string;
  /** The question above the note field. Leave out for a dialog with no note. */
  label?: string;
  /** Shown when the note is empty; leave out when the note is optional. */
  required?: string;
  submit: string;
  tone?: "move" | "danger" | "primary";
  onSubmit: (note: string) => void;
}

/** Mount it only while it is open, so each prompt starts empty. */
export function NoteDialog({ prompt, onClose }: { prompt: NotePrompt; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const field = useId();
  useReturnFocus();

  function submit() {
    if (prompt.required && !note.trim()) {
      setMissing(true);
      return;
    }
    prompt.onSubmit(note.trim());
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={prompt.title}
      description={prompt.description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" className="max-sm:h-10 max-sm:flex-1" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={prompt.tone ?? "primary"} className="max-sm:h-10 max-sm:flex-1" onClick={submit}>
            {prompt.submit}
          </Button>
        </>
      }
    >
      {prompt.label && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={field} className="text-xs font-medium text-ink-2">
              {prompt.label}
            </label>
            <span className="max-sm:hidden" aria-hidden>
              <Kbd>{`${MOD} ↵`}</Kbd>
            </span>
          </div>
          <Textarea
            id={field}
            autoFocus
            autoGrow
            rows={3}
            value={note}
            aria-invalid={missing}
            aria-describedby={missing ? `${field}-error` : undefined}
            onChange={(e) => {
              setNote(e.target.value);
              setMissing(false);
            }}
            onKeyDown={(e) => sendOnModEnter(e, submit)}
            className="min-h-20 max-sm:text-base"
          />
          {missing && (
            <p id={`${field}-error`} role="alert" className="text-xs text-danger">
              {prompt.required}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

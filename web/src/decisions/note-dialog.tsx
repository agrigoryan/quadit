// The small dialog that asks for a note before an answer is sent: what to
// change, why none of the options fit, what is unclear. It also serves as
// the plain "are you sure" before a question is deleted.

import { useId, useState } from "react";
import { MOD } from "@/hooks/hotkeys";
import { refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Textarea } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { useReturnFocus } from "@/decisions/data";

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
  const errors = useFieldErrors(["note"]);
  const missing = errors.fields.note;
  const field = useId();
  useReturnFocus();

  function submit() {
    if (prompt.required && !note.trim()) refuse("note", prompt.required);
    prompt.onSubmit(note.trim());
  }

  return (
    <FormDialog
      title={prompt.title}
      description={prompt.description}
      size="sm"
      submit={prompt.submit}
      tone={prompt.tone}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
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
            aria-invalid={!!missing}
            aria-describedby={missing ? `${field}-error` : undefined}
            onChange={(e) => {
              setNote(e.target.value);
              errors.set("note", "");
            }}
            className="min-h-20 max-sm:text-base"
          />
          {missing && (
            <p id={`${field}-error`} role="alert" className="text-xs text-danger">
              {missing}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}

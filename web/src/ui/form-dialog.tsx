import { type ComponentProps, type FormEvent, type ReactNode, useId } from "react";
import { t } from "@/lib/i18n";
import { sendOnModEnter } from "@/lib/mod-enter";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { type FieldErrors, FormAlert, useSubmit } from "@/ui/form";

interface Props {
  title: string;
  description?: string;
  size?: ComponentProps<typeof Dialog>["size"];
  /** The words on the button that sends the form: "Create", "Save". */
  submit: string;
  /** The words on that button while the request is out ("Restoring…"). Left out, the button only goes off. */
  submitting?: string;
  /** The button's colour: "danger" for a form that takes something away, "move" for an answer. */
  tone?: "primary" | "danger" | "move";
  /** False keeps the button off: what is typed cannot be sent yet (no name, dates the wrong way round). */
  ready?: boolean;
  /** The form's errors, from useFieldErrors: each field shows its own; a refusal that names none shows here. */
  errors: Pick<FieldErrors, "form" | "clear" | "fail">;
  /**
   * Sends the form. The dialog closes when it resolves. What it throws (the
   * server's refusal, or a browser check made with `refuse`) goes to `errors`,
   * and the dialog stays with the fields as typed.
   */
  onSubmit: () => Promise<unknown> | void;
  /** Cancel, Escape, the close button, and a submit that went through. */
  onClose: () => void;
  /** The fields. The first one has the focus when the dialog opens. */
  children: ReactNode;
}

/**
 * A form in a modal dialog: the title, the fields, Cancel and the button that
 * sends it, which is off while the request is out. Enter in a field or
 * Cmd/Ctrl-Enter anywhere in the form sends it. Mount it only while it is
 * open, so each opening starts from the fields' first values.
 */
export function FormDialog({
  title,
  description,
  size,
  submit,
  submitting,
  tone = "primary",
  ready = true,
  errors,
  onSubmit,
  onClose,
  children,
}: Props) {
  const id = useId();
  const { busy, run } = useSubmit(errors, { once: true });

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    await run(async () => {
      await onSubmit();
      onClose();
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button className="max-sm:h-10" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={id} variant={tone} className="max-sm:h-10" disabled={busy || !ready}>
            {busy && submitting ? submitting : submit}
          </Button>
        </>
      }
    >
      <form
        id={id}
        noValidate
        aria-busy={busy}
        onSubmit={(e) => void send(e)}
        onKeyDown={(e) => {
          // A field that sends on Cmd/Ctrl-Enter by itself has done so already.
          const form = e.currentTarget;
          if (!e.defaultPrevented) sendOnModEnter(e, () => form.requestSubmit());
        }}
        className="flex flex-col gap-3.5"
      >
        {children}
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

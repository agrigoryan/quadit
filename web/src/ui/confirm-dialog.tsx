import { type ReactNode, useState } from "react";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormAlert } from "@/ui/form";

interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, in a sentence or two. */
  body?: ReactNode;
  /** The word on the button that does it: "Remove", "Revoke". */
  confirm: string;
  /** Not destructive: the button is the ordinary blue one. */
  safe?: boolean;
  /** Does it. The dialog closes when this resolves and shows the message when it throws. */
  onConfirm: () => Promise<unknown> | void;
  children?: ReactNode;
}

/** Asks before something that cannot be undone, and shows the server's refusal if it says no. */
export function ConfirmDialog({ open, onOpenChange, title, body, confirm, safe, onConfirm, children }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const change = (next: boolean) => {
    if (!next) setError("");
    onOpenChange(next);
  };

  async function run() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      change(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={() => change(false)}>{t("common.cancel")}</Button>
          <Button variant={safe ? "primary" : "danger"} disabled={busy} onClick={() => void run()}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {body && <p className="text-sm text-ink-2">{body}</p>}
        {children}
        <FormAlert>{error}</FormAlert>
      </div>
    </Dialog>
  );
}

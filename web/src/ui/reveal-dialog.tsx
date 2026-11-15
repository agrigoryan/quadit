// A value to take away, and the dialog that shows a secret the one time it
// can be shown.

import { type ReactNode, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cx } from "@/lib/cx";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

interface CopyFieldProps {
  label?: string;
  value: string;
  /** Several lines (recovery codes, a command): keep the line breaks. */
  multiline?: boolean;
  className?: string;
}

/** A value to take away: shown in full, selectable, with a Copy button. */
export function CopyField({ label, value, multiline, className }: CopyFieldProps) {
  const [done, setDone] = useState(false);
  async function copy() {
    if (await copyText(value)) {
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } else {
      toast.error(t("common.copyFailed"));
    }
  }
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      {label && <span className="text-xs font-medium text-ink-2">{label}</span>}
      <div className="flex min-w-0 items-stretch gap-1.5">
        <code
          className={cx(
            "min-w-0 flex-1 rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-xs leading-5 text-ink select-all",
            multiline ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-nowrap no-scrollbar",
          )}
        >
          {value}
        </code>
        <Button
          onClick={() => void copy()}
          className="h-auto min-h-8 self-start"
          aria-label={label ? `${t("s.copy")}: ${label}` : t("s.copy")}
        >
          {done ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {done ? t("common.copied") : t("s.copy")}
        </Button>
      </div>
    </div>
  );
}

interface RevealProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Why this is the only chance to copy it. */
  warning: string;
  /** What to copy: the secret first, then anything made from it (a command line, an address). */
  items: { label: string; value: string; multiline?: boolean }[];
  children?: ReactNode;
}

/** Shows a secret once: a token, a signing secret, recovery codes. Closing it is the end of it. */
export function RevealDialog({ open, onClose, title, warning, items, children }: RevealProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("s.done")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="rounded-md bg-wait-soft px-2.5 py-2 text-sm text-wait">{warning}</p>
        {items.map((item) => (
          <CopyField key={item.label} label={item.label} value={item.value} multiline={item.multiline} />
        ))}
        {children}
      </div>
    </Dialog>
  );
}

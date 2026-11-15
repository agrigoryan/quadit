// A yes/no install setting as a switch that saves the moment it is flipped.

import { type ReactNode, useState } from "react";
import { Lock } from "lucide-react";
import { ApiError, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSetting } from "@/admin/settings";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { SwitchRow } from "@/ui/form";

interface Props {
  name: string;
  /** What the server assumes when nothing is stored. */
  fallback: boolean;
  title: string;
  hint?: ReactNode;
  /** Ask first before flipping to this value (turning off passwords, requiring a second step). */
  confirm?: { when: boolean; title: string; body: string; action: string };
}

export function SettingSwitch({ name, fallback, title, hint, confirm }: Props) {
  const setting = useSetting(name, fallback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);

  async function save(next: boolean) {
    setBusy(true);
    setError("");
    try {
      await setting.save(next);
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  function flip(next: boolean) {
    if (confirm && confirm.when === next) setAsking(true);
    else void save(next).catch(() => {});
  }

  return (
    <div className="px-3 py-2">
      <SwitchRow title={title} hint={hint} checked={setting.value} disabled={busy || setting.locked} onChange={flip} />
      {setting.locked && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
          <Lock className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            {t("admin.locked")} <code className="font-mono break-all text-ink-2">{setting.env}</code>
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger first-letter:uppercase">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={confirm.title}
          body={confirm.body}
          confirm={confirm.action}
          onConfirm={() =>
            save(confirm.when).catch((err: unknown) => {
              // Refused as things stand (it would leave no way to sign in): the reason shows by the switch, which stays as it was.
              if (err instanceof ApiError && err.status === 409) return;
              throw err;
            })
          }
        />
      )}
    </div>
  );
}

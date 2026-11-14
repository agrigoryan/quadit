// What "Sync now" answered, shown under the row it was pressed on.

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";

export type SyncState = { busy: true } | { busy: false; ok: boolean; text: string };

export function SyncLine({ state }: { state: SyncState | undefined }) {
  if (!state) return null;
  if (state.busy) return <p className="text-xs text-ink-3">{t("auto.syncing")}</p>;
  return (
    <p role="status" className={cx("rounded-md px-2 py-1 text-xs break-words", state.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")}>
      {state.text}
    </p>
  );
}

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";

export function Spinner({ className, label = t("common.loading") }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent", className)}
    />
  );
}

/** A spinner in the middle of whatever space it is given. */
export function Loading() {
  return (
    <div className="flex h-full min-h-32 items-center justify-center">
      <Spinner />
    </div>
  );
}

// A moment shown as a relative time, with the exact time on hover.

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { Ago } from "@/ui/ago";

/** A moment as "3h" with the exact time on hover; a dash when there is none. */
export function When({ ms, className }: { ms: number | undefined; className?: string }) {
  if (!ms) return <span className={cx("text-ink-3", className)}>{t("s.never")}</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={exact(ms)} className={cx("tnum whitespace-nowrap", className)}>
      <Ago ms={ms} />
    </time>
  );
}

// A note shown while finished tasks are still loading, so an empty list is
// not read as "none".

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useRestLoaded } from "@/lib/store";
import { useDelayedFlag } from "@/lib/use-delayed-flag";
import { Spinner } from "@/ui/spinner";

/**
 * A quiet line for any place that lists finished work (a Done column, the
 * Done group, a history): shown while the finished tasks are still on their
 * way, so that an empty list is not read as "none". Draws nothing once they
 * have arrived.
 *
 *   {done.length === 0 && <RestLoadingNote />}
 */
export function RestLoadingNote({ className }: { className?: string }) {
  const loaded = useRestLoaded();
  if (loaded) return null;
  return (
    <output className={cx("flex items-center gap-2 text-xs text-ink-3", className)}>
      <Spinner className="size-3 border-[1.5px]" label={t("sync.loadingRest")} />
      {t("sync.loadingRest")}
    </output>
  );
}

/** The same note for the top bar: only when the finished work takes more than a moment. */
export function RestLoadingHint() {
  const visible = useDelayedFlag(!useRestLoaded(), 900);
  if (!visible) return null;
  return <RestLoadingNote className="shrink-0 animate-fade max-sm:hidden" />;
}

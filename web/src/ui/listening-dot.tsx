import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";

/**
 * A small dot beside an agent wherever one is chosen: green when something
 * is listening for its work right now, grey when a task given to it would
 * sit until a program connects. The words are in its title and for screen
 * readers.
 */
export function ListeningDot({ on, className }: { on: boolean; className?: string }) {
  const label = on ? t("agents.listening") : t("agents.notListening");
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a picture drawn with CSS or SVG, not an image file
      role="img"
      aria-label={label}
      title={on ? t("agents.listeningHint") : t("agents.notListeningHint")}
      className={cx(
        "inline-block size-2 shrink-0 rounded-full",
        on ? "bg-ok" : "border border-line-strong bg-transparent",
        className,
      )}
    />
  );
}

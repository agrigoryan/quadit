// The "Recommended" and "Picked" marks on a decision's options.

import { Check, ThumbsUp } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Badge } from "@/ui/badge";

export function RecommendedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="accent" className={className}>
      <ThumbsUp className="size-3" aria-hidden />
      {t("decision.recommended")}
    </Badge>
  );
}

/** The mark on the option that was picked: solid, so it cannot be mistaken for "Recommended". */
export function PickedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-accent px-1.5 text-xs font-semibold text-accent-ink",
        className,
      )}
    >
      <Check className="size-3" strokeWidth={3} aria-hidden />
      {t("decision.picked")}
    </span>
  );
}

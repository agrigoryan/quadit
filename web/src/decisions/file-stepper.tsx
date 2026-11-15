// "‹ 2 of 3 ›": stepping through an option's files.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";

interface StepperProps {
  index: number;
  total: number;
  onStep: (delta: number) => void;
  /** Drawn for the dark compare stage instead of the page. */
  onDark?: boolean;
  className?: string;
}

/** "‹ 2 of 3 ›" for an option with several files. Nothing when it has one. */
export function FileStepper({ index, total, onStep, onDark, className }: StepperProps) {
  if (total < 2) return null;
  const button = cx(
    "flex size-6 items-center justify-center rounded-sm disabled:opacity-40",
    onDark ? "text-inverse-ink hover:bg-white/15" : "text-ink-2 hover:bg-hover hover:text-ink",
  );
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tnum",
        onDark ? "text-inverse-ink" : "text-ink-2",
        className,
      )}
    >
      <button
        type="button"
        aria-label={t("decision.file.prev")}
        disabled={index === 0}
        onClick={() => onStep(-1)}
        className={button}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span aria-live="polite">{t("decision.file.count", { n: index + 1, total })}</span>
      <button
        type="button"
        aria-label={t("decision.file.next")}
        disabled={index === total - 1}
        onClick={() => onStep(1)}
        className={button}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </span>
  );
}

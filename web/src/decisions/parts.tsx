// Small pieces the decision block and the compare view share: a person in a
// sentence, the "Recommended" and "Picked" marks, and the stepper through
// an option's files.

import { Fragment, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, ThumbsUp } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { nameOf } from "@/decisions/data";

/** Fills the {name} places of a translated sentence with elements. */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{name && name in parts ? parts[name] : piece}</Fragment>;
  });
}

/** Someone named in a sentence: avatar and name, or "you". */
export function Who({ userId, capital }: { userId: string | undefined; capital?: boolean }) {
  const member = useMember(userId);
  const me = useMe();
  const isMe = userId === me.user_id;
  return (
    <span className="inline-flex items-center gap-1 align-middle font-medium text-ink">
      <Avatar member={member} size="xs" className={member?.kind === "agent" ? "mr-0.5" : undefined} />
      {isMe ? (capital ? t("decision.youCapital") : t("common.you")) : nameOf(member, t("common.someone"))}
    </span>
  );
}

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

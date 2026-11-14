import type { HTMLAttributes } from "react";
import { cx } from "@/lib/cx";

type Tone = "neutral" | "accent" | "move" | "ok" | "danger" | "wait";

const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-2 border-line",
  accent: "bg-accent-soft text-accent-text border-transparent",
  move: "bg-move text-move-ink border-transparent font-semibold",
  ok: "bg-ok-soft text-ok border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  wait: "bg-wait-soft text-wait border-transparent",
};

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = "neutral", className, ...rest }: Props) {
  return (
    <span
      className={cx(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** A label as a small dot and its name. The colour is the team's own. */
export function LabelChip({ name, color, className }: { name: string; color?: string; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-xs text-ink-2 whitespace-nowrap",
        className,
      )}
    >
      <span className="size-2 rounded-full" style={{ background: color || "var(--ink-3)" }} />
      {name}
    </span>
  );
}

// Select options as coloured chips. The eight colours are tints that read
// on both themes: a wash of the hue behind text pulled toward the ink.

import { cx } from "@/lib/cx";
import type { DBProperty, SelectOption } from "@/lib/types-docs";

const HUES: Record<string, string> = {
  gray: "#8b90a0",
  blue: "#3b82f6",
  green: "#16a34a",
  yellow: "#ca8a04",
  orange: "#ea580c",
  red: "#dc2626",
  purple: "#9333ea",
  pink: "#db2777",
};

const hueOf = (color: string | undefined) => HUES[color ?? "gray"] ?? HUES.gray;

function optionStyle(color: string | undefined) {
  const hue = hueOf(color);
  return {
    background: `color-mix(in srgb, ${hue} 20%, transparent)`,
    color: `color-mix(in srgb, ${hue} 55%, var(--ink))`,
  };
}

export const optionsOf = (prop: Pick<DBProperty, "config">): SelectOption[] => prop.config?.options ?? [];

export function findOption(prop: Pick<DBProperty, "config">, name: string): SelectOption {
  return optionsOf(prop).find((o) => o.name === name) ?? { name, color: "gray" };
}

export function OptionChip({ option, className }: { option: SelectOption; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 max-w-full shrink-0 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={optionStyle(option.color)}
    >
      <span className="truncate">{option.name}</span>
    </span>
  );
}

/** A dot of an option colour, for pickers. */
export function ColorDot({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <span
      className={cx("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ background: hueOf(color) }}
      aria-hidden
    />
  );
}

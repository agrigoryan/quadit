import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";

interface Props {
  value: string;
  /** Called with the new name when it changed and is not empty. */
  onSave: (name: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** A name edited in place: Enter or leaving the field saves, Escape puts the old name back. */
export function InlineName({ value, onSave, label, disabled, className }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  function commit() {
    const next = text.trim();
    if (next && next !== value) onSave(next);
    else setText(value);
  }

  if (disabled) return <span className={cx("min-w-0 flex-1 truncate text-sm font-medium", className)}>{value}</span>;
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(value);
          // Leave the field without saving what was typed.
          const el = e.currentTarget;
          setTimeout(() => el.blur());
        }
      }}
      className={cx(
        "h-7 min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1.5 text-sm font-medium text-ink outline-none",
        "hover:border-line-strong focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25",
        className,
      )}
    />
  );
}

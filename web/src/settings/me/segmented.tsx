import { cx } from "@/lib/cx";

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** Said by screen readers for the group. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  disabled?: boolean;
}

/** A few choices side by side, one picked: theme, how much mail. Arrow keys move the pick. */
export function Segmented<T extends string>({ label, value, onChange, options, disabled }: Props<T>) {
  function onKey(e: React.KeyboardEvent) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + step + options.length) % options.length];
    if (next) onChange(next.value);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[(i + step + options.length) % options.length]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey} className="inline-flex max-w-full rounded-md border border-line-strong bg-sunken p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "h-6 min-w-0 truncate rounded-sm px-3 text-sm transition-colors disabled:opacity-60",
              on ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

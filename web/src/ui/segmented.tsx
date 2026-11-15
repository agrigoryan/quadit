import { cx } from "@/lib/cx";
import { Radio, RadioGroup } from "@/ui/radio-group";

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

/** A few choices side by side, one picked: theme, how much mail. */
export function Segmented<T extends string>({ label, value, onChange, options, disabled }: Props<T>) {
  return (
    <RadioGroup
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="inline-flex max-w-full rounded-md border border-line-strong bg-sunken p-0.5"
    >
      {options.map((o) => (
        <Radio
          key={o.value}
          value={o.value}
          className={cx(
            "h-6 min-w-0 truncate rounded-sm px-3 text-sm transition-colors disabled:opacity-60",
            o.value === value ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}

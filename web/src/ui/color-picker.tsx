// Picking a colour: one of the swatches, or any other.

import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { SWATCHES } from "@/lib/swatches";
import { Radio, RadioGroup } from "@/ui/radio-group";

interface ColorProps {
  value: string;
  onChange: (color: string) => void;
  label: string;
}

/** A row of swatches, plus the browser's colour well for anything else. */
export function ColorPicker({ value, onChange, label }: ColorProps) {
  const custom = !!value && !SWATCHES.includes(value.toLowerCase());
  return (
    <RadioGroup
      label={label}
      value={value.toLowerCase()}
      onChange={onChange}
      className="flex flex-wrap items-center gap-1.5"
    >
      {SWATCHES.map((color) => (
        <Radio
          key={color}
          value={color}
          aria-label={tMaybe(`swatch.${color}`, color)}
          className={cx(
            "size-5 rounded-full ring-offset-2 ring-offset-surface transition-shadow",
            value.toLowerCase() === color ? "ring-2 ring-ink" : "hover:ring-2 hover:ring-line-strong",
          )}
          style={{ background: color }}
        />
      ))}
      <label
        className={cx(
          "relative flex size-5 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-line-strong text-2xs text-ink-3 ring-offset-2 ring-offset-surface",
          custom && "border-solid ring-2 ring-ink",
        )}
        style={custom ? { background: value } : undefined}
        title={t("s.customColor")}
      >
        {!custom && "+"}
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#6b7183"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("s.customColor")}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </RadioGroup>
  );
}

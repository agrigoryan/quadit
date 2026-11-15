// One choice of a few, drawn as buttons (a segmented control, colour
// swatches, cards). Radix's radio group gives the keyboard a radio group
// has: the group is one Tab stop, on the picked choice; the arrows move and
// pick; Home and End go to the first and the last choice and pick it.

import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { RadioGroup as RRadio } from "radix-ui";

interface GroupProps<T extends string> {
  /** Said by screen readers for the group. */
  label: string;
  /** The picked choice; null, or one that matches no Radio, picks none. */
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function RadioGroup<T extends string>({ label, value, onChange, disabled, className, children }: GroupProps<T>) {
  // Radix moves the focus on Home and End but picks only on the arrows.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Home" && e.key !== "End") return;
    const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    const end = e.key === "Home" ? radios[0] : radios[radios.length - 1];
    if (end && end.value !== value) onChange(end.value as T);
  }
  return (
    <RRadio.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
      onKeyDown={onKeyDown}
      className={className}
    >
      {children}
    </RRadio.Root>
  );
}

/** One choice of a RadioGroup: a button, `aria-checked` and `data-state="checked"` when picked. */
export function Radio(props: ComponentProps<typeof RRadio.Item>) {
  return <RRadio.Item type="button" {...props} />;
}

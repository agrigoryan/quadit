// One choice of a few, drawn as buttons (a segmented control, colour
// swatches, cards), with the keyboard of a radio group: the group is one
// Tab stop, on the picked choice; the arrows move and pick, round the ends;
// Home and End go to the first and the last choice and pick it. Radix's
// radio group does the roving focus.

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
  // Radix moves the focus, a moment after the key press, and picks the
  // choice it lands on only if an arrow key is still held then (a quick
  // press, a script or some assistive technology lets go first), and never
  // for Home and End. So the pick is made here, at the key press.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    const at = radios.findIndex((radio) => radio === e.target);
    if (at < 0) return;
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? radios.length - 1
          : e.key in step
            ? (at + (step[e.key] ?? 0) + radios.length) % radios.length
            : -1;
    const next = radios[to];
    if (next && next.value !== value) onChange(next.value as T);
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

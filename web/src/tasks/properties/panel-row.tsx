// The rows of a task's property panel (detail/properties.tsx): a labelled
// row, the button a value sits in, the box a typed value sits in, and the
// row of a property picked from a list.

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "@/lib/cx";
import type { PanelProps, PickerProperty } from "@/tasks/properties/property";
import { TaskPropertyPicker } from "@/tasks/property-picker";

/** One property: its name at the left, its value at the right. */
export function PropRow({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("flex min-w-0 items-start gap-2", wide && "sm:col-span-2")}>
      <dt className="w-[5.5rem] shrink-0 py-[5px] text-xs text-ink-2 max-md:py-[9px]">{label}</dt>
      <dd className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 max-md:min-h-9">{children}</dd>
    </div>
  );
}

const valueBox =
  "-ml-1.5 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sm max-md:h-9 " +
  "hover:bg-hover data-[state=open]:bg-hover disabled:pointer-events-none";

interface PropButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Nothing is set: shown faintly. */
  empty?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** The clickable value of a property; opens its picker. */
export function PropButton({ empty, className, type = "button", ...rest }: PropButtonProps) {
  return <button type={type} className={cx(valueBox, empty ? "text-ink-3" : "text-ink", className)} {...rest} />;
}

/** A value typed in place (an estimate, a day): a box that looks like the other values until it has the focus. */
export const inlineField =
  "-ml-1.5 h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-ink outline-none max-md:h-9 " +
  "hover:bg-hover focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 read-only:pointer-events-none";

interface PickerRowProps {
  property: PickerProperty;
  panel: PanelProps;
  /** The value in words, for the button's name: "Status: In progress". */
  value: string;
  /** Nothing is set. */
  empty?: boolean;
  /** Across both columns of a wide panel. */
  wide?: boolean;
  className?: string;
  /** What the button shows. */
  children: ReactNode;
  /** Shown after the button, in the same row. */
  after?: ReactNode;
}

/** The row of a property picked from a list: its value is a button that opens the picker. */
export function PickerRow({ property, panel, value, empty, wide, className, children, after }: PickerRowProps) {
  const { task, readOnly, picker, takeControl } = panel;
  const title = property.title();
  return (
    <PropRow label={title} wide={wide}>
      <TaskPropertyPicker property={property} tasks={[task]} {...picker}>
        <PropButton
          ref={takeControl}
          disabled={readOnly}
          empty={empty}
          aria-label={`${title}: ${value}`}
          className={className}
        >
          {children}
        </PropButton>
      </TaskPropertyPicker>
      {after}
    </PropRow>
  );
}

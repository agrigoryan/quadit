// The rows and groups every page of the command palette is made of.

import { Children, type ReactNode } from "react";
import { Command } from "cmdk";
import { Check } from "lucide-react";
import { Kbd } from "@/ui/kbd";

interface ItemProps {
  /** Unique in the palette; cmdk tracks the selected row by it. */
  value: string;
  icon?: ReactNode;
  children: ReactNode;
  /** Faint text after the label: a handle, a snippet. */
  detail?: ReactNode;
  /** A keyboard shortcut that does the same thing. */
  hint?: string;
  /** Marks the choice in effect now. */
  checked?: boolean;
  onSelect: () => void;
}

export function Item({ value, icon, children, detail, hint, checked, onSelect }: ItemProps) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-ink select-none data-[selected=true]:bg-hover max-sm:h-10"
    >
      {icon && <span className="flex w-4 shrink-0 items-center justify-center text-ink-2 [&>svg]:size-4">{icon}</span>}
      <span className="min-w-0 shrink truncate">{children}</span>
      <span className="min-w-0 flex-1 basis-0 truncate text-ink-3">{detail}</span>
      {checked && <Check className="size-4 shrink-0 text-ink-2" aria-hidden />}
      {hint && <Kbd>{hint}</Kbd>}
    </Command.Item>
  );
}

const headingStyle =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 " +
  "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3";

/** A titled run of rows. Renders nothing when it has no rows. */
export function Group({ heading, children }: { heading?: string; children: ReactNode }) {
  if (Children.toArray(children).length === 0) return null;
  return (
    <Command.Group heading={heading} className={headingStyle}>
      {children}
    </Command.Group>
  );
}

/** A plain line in place of rows: nothing found, still searching. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-6 text-center text-sm text-ink-3">{children}</p>;
}

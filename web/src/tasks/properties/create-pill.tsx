// A property's button in the row under a new task's description, in the
// create dialog (tasks/create-fields.tsx): a small pill that opens a picker.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import type { ManageLink } from "@/tasks/manage";
import { NONE } from "@/tasks/properties/property";

export const pill =
  "flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-ink-2 " +
  "hover:bg-hover hover:text-ink data-[state=open]:bg-hover";

/** What a pill shows: a mark and the value, or the property's name while nothing is set. */
export function Pill({ icon, children, set }: { icon: ReactNode; children: ReactNode; set: boolean }) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={cx("truncate", set && "font-medium text-ink")}>{children}</span>
    </>
  );
}

/** A picker's way to a settings page that first lets the dialog close. */
export const leaving = (link: ManageLink | undefined, onLeave: (() => void) | undefined): ManageLink | undefined =>
  link && {
    label: link.label,
    onSelect: () => {
      onLeave?.();
      link.onSelect();
    },
  };

/** The value of a "none" row is no value at all. */
export const orNone = (id: string) => (id === NONE ? "" : id);

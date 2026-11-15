import type { ComponentProps } from "react";
import { Popover as RPopover } from "radix-ui";
import { cx } from "@/lib/cx";

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export const PopoverAnchor = RPopover.Anchor;
export const PopoverClose = RPopover.Close;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...rest
}: ComponentProps<typeof RPopover.Content>) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cx(
          "z-[60] max-h-[var(--radix-popover-content-available-height)] min-w-48 overflow-auto rounded-lg bg-surface text-ink shadow-pop outline-none animate-pop",
          className,
        )}
        {...rest}
      />
    </RPopover.Portal>
  );
}

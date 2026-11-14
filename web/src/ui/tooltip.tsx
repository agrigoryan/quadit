import type { ReactNode } from "react";
import { Tooltip as RTooltip } from "radix-ui";
import { Kbd } from "@/ui/kbd";

export const TooltipProvider = RTooltip.Provider;

interface Props {
  label: ReactNode;
  /** A keyboard shortcut shown after the label. */
  hint?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}

export function Tooltip({ label, hint, side = "bottom", children }: Props) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[80] flex max-w-64 items-center gap-2 rounded-sm bg-inverse px-2 py-1 text-xs text-inverse-ink shadow-pop animate-fade"
        >
          {label}
          {hint && <Kbd onDark>{hint}</Kbd>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

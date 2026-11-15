import type { ComponentProps, ReactNode } from "react";
import { DropdownMenu as RMenu } from "radix-ui";
import { Check } from "lucide-react";
import { cx } from "@/lib/cx";
import { Kbd } from "@/ui/kbd";

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;
export const MenuRadioGroup = RMenu.RadioGroup;

const item =
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm text-ink outline-none select-none " +
  "data-[highlighted]:bg-hover data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-2";

export function MenuContent({
  className,
  align = "start",
  sideOffset = 6,
  ...rest
}: ComponentProps<typeof RMenu.Content>) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cx(
          "z-[60] min-w-44 rounded-lg bg-surface p-1 text-ink shadow-pop outline-none animate-pop",
          className,
        )}
        {...rest}
      />
    </RMenu.Portal>
  );
}

interface ItemProps extends ComponentProps<typeof RMenu.Item> {
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
}

export function MenuItem({ icon, hint, danger, className, children, ...rest }: ItemProps) {
  return (
    <RMenu.Item className={cx(item, danger && "text-danger [&>svg]:text-danger", className)} {...rest}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </RMenu.Item>
  );
}

export function MenuRadioItem({ className, children, ...rest }: ComponentProps<typeof RMenu.RadioItem>) {
  return (
    <RMenu.RadioItem className={cx(item, className)} {...rest}>
      <span className="flex-1 truncate">{children}</span>
      <RMenu.ItemIndicator>
        <Check className="size-4 text-accent-text" />
      </RMenu.ItemIndicator>
    </RMenu.RadioItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-ink-3">{children}</RMenu.Label>;
}

export function MenuSeparator() {
  return <RMenu.Separator className="-mx-1 my-1 h-px bg-line" />;
}

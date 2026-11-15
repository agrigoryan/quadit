import { type ReactNode, type RefObject, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Button, type ButtonProps } from "@/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";

export interface PickerItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown faintly at the right: a count, a key, a kind. */
  hint?: ReactNode;
  /** More words the search should match. */
  keywords?: string;
}

/** Search by plain substring over the label and keywords: no surprises. */
function matches(_value: string, search: string, keywords?: string[]): number {
  return (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;
}

interface ListProps {
  items: PickerItem[];
  /** The id, or ids, picked now. */
  value?: string | string[] | null;
  onPick: (id: string) => void;
  placeholder?: string;
  label: string;
  footer?: ReactNode;
}

/** The searchable list itself, for use inside any popover or dialog. */
export function PickerList({ items, value, onPick, placeholder, label, footer }: ListProps) {
  const picked = new Set(Array.isArray(value) ? value : value ? [value] : []);
  return (
    <Command label={label} filter={matches} loop className="flex max-h-80 w-60 flex-col">
      <Command.Input
        autoFocus
        placeholder={placeholder ?? t("common.search")}
        className="h-9 w-full shrink-0 border-b border-line bg-transparent px-3 text-sm outline-none"
      />
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
        <Command.Empty className="px-2 py-3 text-center text-sm text-ink-3">{t("common.noMatches")}</Command.Empty>
        {items.map((item) => (
          <Command.Item
            key={item.id}
            value={item.id}
            keywords={[item.label, item.keywords ?? ""]}
            onSelect={() => onPick(item.id)}
            className="flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm select-none data-[selected=true]:bg-hover"
          >
            {item.icon && <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-xs text-ink-3">{item.hint}</span>}
            {picked.has(item.id) && <Check className="size-4 shrink-0 text-accent-text" aria-hidden />}
          </Command.Item>
        ))}
      </Command.List>
      {footer && <div className="border-t border-line p-1">{footer}</div>}
    </Command>
  );
}

interface PickerProps extends ListProps {
  /** Several can be picked: the list stays open and each pick toggles. */
  multiple?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the picker. Leave out when using `anchor`. */
  children?: ReactNode;
  /** Open next to this element instead of a trigger (for keyboard shortcuts on a row). */
  anchor?: RefObject<Element | null>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

/** A combobox with search, in a popover. The base of every property picker. */
export function Picker({ multiple, open, onOpenChange, children, anchor, align, side, onPick, ...list }: PickerProps) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      <PopoverContent align={align} side={side} className="p-0">
        <PickerList
          {...list}
          onPick={(id) => {
            onPick(id);
            if (!multiple) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface SelectProps extends Omit<PickerProps, "children" | "value" | "multiple" | "anchor"> {
  value: string | undefined;
  /** Shown before the picked value: "Sort: Priority". */
  prefix?: string;
  buttonProps?: ButtonProps;
}

/** A button that shows the picked item and opens a Picker to change it. */
export function Select({ value, prefix, buttonProps, items, ...rest }: SelectProps) {
  const current = items.find((i) => i.id === value);
  return (
    <Picker items={items} value={value} {...rest}>
      <Button {...buttonProps} className={cx("justify-between gap-1", buttonProps?.className)}>
        <span className="flex min-w-0 items-center gap-1.5">
          {current?.icon}
          {prefix && <span className="text-ink-3">{prefix}</span>}
          <span className="truncate">{current?.label ?? rest.placeholder ?? rest.label}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      </Button>
    </Picker>
  );
}

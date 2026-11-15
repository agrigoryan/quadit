// The searchable list every property picker is made of, the same list in a
// popover, and a button that opens it to show what is picked. The list can
// also make a new choice from what was typed and lead to the page where the
// choices are managed, so a label is made where it is first needed.

import { type ReactNode, type RefObject, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Plus, Settings2 } from "lucide-react";
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

/** A row that leads away from the list: to the page where its choices are managed. */
export interface PickerAction {
  label: string;
  onSelect: () => void;
}

interface ListProps {
  items: PickerItem[];
  /** The id, or ids, picked now. */
  value?: string | string[] | null;
  onPick: (id: string) => void;
  placeholder?: string;
  label: string;
  /** What the list says when it has nothing to show and nothing to make. */
  empty?: string;
  /** Draws a row's content in place of its icon, label and hint. */
  row?: (item: PickerItem) => ReactNode;
  /** Makes a choice named by what was typed; offered while no choice has that name. */
  onCreate?: (name: string) => void;
  /** What that offer says, given the name: "Create label “x”". The name itself when left out. */
  createLabel?: (name: string) => ReactNode;
  /** A last row that opens the page where the choices are managed. */
  manage?: PickerAction;
}

const rowClass =
  "flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm select-none data-[selected=true]:bg-hover";

/** Plain substring search over the label and keywords: no surprises. */
const found = (item: PickerItem, query: string) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(query);

/**
 * The searchable list itself, for use inside any popover or dialog. Arrows
 * move, Enter picks, typing narrows it; a pick empties the search.
 */
export function PickerList({
  items,
  value,
  onPick,
  placeholder,
  label,
  empty,
  row,
  onCreate,
  createLabel,
  manage,
}: ListProps) {
  const [search, setSearch] = useState("");
  const picked = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const typed = search.trim();
  const query = typed.toLowerCase();
  const shown = query ? items.filter((item) => found(item, query)) : items;
  const canCreate = !!onCreate && typed !== "" && !items.some((item) => item.label.toLowerCase() === query);

  return (
    <Command label={label} shouldFilter={false} loop className="flex max-h-80 w-60 flex-col">
      <Command.Input
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={placeholder ?? t("common.search")}
        className="h-9 w-full shrink-0 border-b border-line bg-transparent px-3 text-sm outline-none"
      />
      <Command.List label={label} className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-sm text-ink-3">{empty ?? t("common.noMatches")}</p>
        )}
        {shown.map((item) => (
          <Command.Item
            key={item.id}
            value={`item:${item.id}`}
            onSelect={() => {
              onPick(item.id);
              setSearch("");
            }}
            className={rowClass}
          >
            {row ? (
              <span className="min-w-0 flex-1">{row(item)}</span>
            ) : (
              <>
                {item.icon && <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="shrink-0 text-xs text-ink-3">{item.hint}</span>}
              </>
            )}
            {picked.has(item.id) && <Check className="size-4 shrink-0 text-accent-text" aria-hidden />}
          </Command.Item>
        ))}
        {canCreate && (
          <Command.Item
            value="picker:create"
            onSelect={() => {
              onCreate(typed);
              setSearch("");
            }}
            className={rowClass}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Plus className="size-3.5 text-ink-2" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
              {createLabel ? createLabel(typed) : typed}
            </span>
          </Command.Item>
        )}
        {manage && (
          <>
            <Command.Separator alwaysRender className="-mx-1 my-1 h-px bg-line" />
            <Command.Item value="picker:manage" onSelect={manage.onSelect} className={cx(rowClass, "text-ink-2")}>
              <span className="flex size-4 shrink-0 items-center justify-center">
                <Settings2 className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">{manage.label}</span>
            </Command.Item>
          </>
        )}
      </Command.List>
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
export function Picker({
  multiple,
  open,
  onOpenChange,
  children,
  anchor,
  align,
  side,
  onPick,
  manage,
  ...list
}: PickerProps) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      <PopoverContent align={align} side={side} aria-label={list.label} className="p-0">
        <PickerList
          {...list}
          onPick={(id) => {
            onPick(id);
            if (!multiple) setOpen(false);
          }}
          manage={
            manage && {
              label: manage.label,
              onSelect: () => {
                setOpen(false);
                manage.onSelect();
              },
            }
          }
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

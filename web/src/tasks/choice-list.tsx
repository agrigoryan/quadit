// A searchable list of choices that can also make a new one and lead to the
// page where the choices are managed. The label and status pickers are made
// of it, so a label can be created where it is first needed and nobody has
// to look for the settings page.

import { type ReactNode, type RefObject, useState } from "react";
import { Command } from "cmdk";
import { Check, Plus, Settings2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { PickerItem } from "@/ui/picker";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";

export interface ChoiceListProps {
  items: PickerItem[];
  /** The id, or ids, picked now. */
  value?: string | string[] | null;
  onPick: (id: string) => void;
  label: string;
  placeholder?: string;
  /** Makes a choice named by what was typed; offered when no choice has that name. */
  onCreate?: (name: string) => void;
  /** What the offer says: "Create label “x”". */
  createLabel?: (name: string) => string;
  /** A last row that opens the page where the choices are managed. */
  manage?: { label: string; onSelect: () => void };
}

const row =
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm select-none data-[selected=true]:bg-hover";

/** Plain substring search over the name and keywords: no surprises. */
const found = (item: PickerItem, q: string) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(q);

export function ChoiceList({
  items,
  value,
  onPick,
  label,
  placeholder,
  onCreate,
  createLabel,
  manage,
}: ChoiceListProps) {
  const [search, setSearch] = useState("");
  const picked = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const typed = search.trim();
  const q = typed.toLowerCase();
  const shown = q ? items.filter((item) => found(item, q)) : items;
  const canCreate = !!onCreate && typed !== "" && !items.some((item) => item.label.toLowerCase() === q);

  return (
    <Command label={label} shouldFilter={false} loop className="flex max-h-80 w-60 flex-col">
      <Command.Input
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={placeholder ?? t("common.search")}
        className="h-9 w-full shrink-0 border-b border-line bg-transparent px-3 text-sm outline-none"
      />
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-sm text-ink-3">{t("common.noMatches")}</p>
        )}
        {shown.map((item) => (
          <Command.Item key={item.id} value={item.id} onSelect={() => onPick(item.id)} className={row}>
            {item.icon && <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-xs text-ink-3">{item.hint}</span>}
            {picked.has(item.id) && <Check className="size-4 shrink-0 text-accent-text" aria-hidden />}
          </Command.Item>
        ))}
        {canCreate && (
          <Command.Item
            value="choice:create"
            onSelect={() => {
              onCreate(typed);
              setSearch("");
            }}
            className={row}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Plus className="size-3.5 text-ink-2" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate">{createLabel ? createLabel(typed) : typed}</span>
          </Command.Item>
        )}
        {manage && (
          <>
            <div role="separator" className="-mx-1 my-1 h-px bg-line" />
            <Command.Item value="choice:manage" onSelect={manage.onSelect} className={`${row} text-ink-2`}>
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

interface PickerProps extends ChoiceListProps {
  /** Several can be picked: the list stays open and each pick toggles. */
  multiple?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the picker. Leave out when using `anchor`. */
  children?: ReactNode;
  anchor?: RefObject<Element | null>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

/** A ChoiceList in a popover, opened by its child. */
export function ChoicePicker({
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
      {anchor && <PopoverAnchor virtualRef={anchor as RefObject<Element>} />}
      <PopoverContent align={align} side={side} className="p-0">
        <ChoiceList
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

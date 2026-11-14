import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Picker, type PickerItem } from "@/ui/picker";

interface Props {
  items: PickerItem[];
  value: string[];
  onChange: (value: string[]) => void;
  /** On the button that opens the list. */
  addLabel: string;
  /** Shown when nothing is picked. */
  empty: ReactNode;
  disabled?: boolean;
}

/** Several picks from a long list: what is picked shows as chips, with a searchable list to add more. */
export function MultiPick({ items, value, onChange, addLabel, empty, disabled }: Props) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.length === 0 && <span className="text-sm text-ink-3">{empty}</span>}
      {value.map((id) => (
        <span key={id} className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-sunken pr-0.5 pl-2 text-xs font-medium text-ink">
          {byId.get(id)?.icon}
          {byId.get(id)?.label ?? id}
          {!disabled && (
            <button
              type="button"
              onClick={() => toggle(id)}
              aria-label={`${t("s.remove")}: ${byId.get(id)?.label ?? id}`}
              className="flex size-5 items-center justify-center rounded-xs text-ink-3 hover:bg-press hover:text-ink"
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Picker items={items} value={value} onPick={toggle} multiple label={addLabel}>
          <Button variant="ghost" size="sm" className="border border-dashed border-line-strong">
            <Plus className="size-3" aria-hidden />
            {addLabel}
          </Button>
        </Picker>
      )}
    </div>
  );
}

import { useState } from "react";
import { Command } from "cmdk";
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { OptionChip, optionsOf } from "@/docs/db/options";
import { type DBProperty, OPTION_COLORS } from "@/lib/types-docs";

interface Props {
  prop: DBProperty;
  /** The options picked now. */
  value: string[];
  multiple: boolean;
  onChange: (value: string[]) => void;
  /** Called after a pick that should close the list (a single select). */
  onClose: () => void;
}

const row =
  "flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm select-none data-[selected=true]:bg-hover";

/**
 * The options of a select, with search. Typing a name that is not an option
 * yet offers to make it. In a single select, picking the chosen one clears it.
 */
export function OptionPicker({ prop, value, multiple, onChange, onClose }: Props) {
  const [search, setSearch] = useState("");
  const options = optionsOf(prop);
  const query = search.trim();
  const shown = options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));
  const fresh = query !== "" && !options.some((o) => o.name.toLowerCase() === query.toLowerCase());

  function pick(name: string) {
    const has = value.includes(name);
    if (multiple) {
      onChange(has ? value.filter((v) => v !== name) : [...value, name]);
      setSearch("");
    } else {
      onChange(has ? [] : [name]);
      onClose();
    }
  }

  return (
    <Command label={prop.name} shouldFilter={false} loop className="flex max-h-80 w-60 flex-col">
      <Command.Input
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={t("db.option.search")}
        className="h-9 w-full shrink-0 border-b border-line bg-transparent px-3 text-sm outline-none"
      />
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 && !fresh && (
          <p className="px-2 py-3 text-center text-sm text-ink-3">{t("db.option.none")}</p>
        )}
        {shown.map((o) => (
          <Command.Item key={o.name} value={`option:${o.name}`} onSelect={() => pick(o.name)} className={row}>
            <span className="min-w-0 flex-1">
              <OptionChip option={o} />
            </span>
            {value.includes(o.name) && <Check className="size-4 shrink-0 text-accent-text" aria-hidden />}
          </Command.Item>
        ))}
        {fresh && (
          <Command.Item value={`create:${query}`} onSelect={() => pick(query)} className={row}>
            <span className="shrink-0 text-ink-2">{t("db.option.create")}</span>
            <OptionChip option={{ name: query, color: OPTION_COLORS[options.length % OPTION_COLORS.length] }} />
          </Command.Item>
        )}
      </Command.List>
    </Command>
  );
}

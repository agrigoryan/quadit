import { t } from "@/lib/i18n";
import { OptionChip, optionsOf } from "@/docs/db/options";
import { type DBProperty, OPTION_COLORS } from "@/lib/types-docs";
import { PickerList } from "@/ui/picker";

interface Props {
  prop: DBProperty;
  /** The options picked now. */
  value: string[];
  multiple: boolean;
  onChange: (value: string[]) => void;
  /** Called after a pick that should close the list (a single select). */
  onClose: () => void;
}

/**
 * The options of a select, with search. Typing a name that is not an option
 * yet offers to make it. In a single select, picking the chosen one clears it.
 */
export function OptionPicker({ prop, value, multiple, onChange, onClose }: Props) {
  const options = optionsOf(prop);

  function pick(name: string) {
    const has = value.includes(name);
    if (multiple) {
      onChange(has ? value.filter((v) => v !== name) : [...value, name]);
    } else {
      onChange(has ? [] : [name]);
      onClose();
    }
  }

  return (
    <PickerList
      label={prop.name}
      placeholder={t("db.option.search")}
      empty={t("db.option.none")}
      items={options.map((o) => ({ id: o.name, label: o.name }))}
      value={value}
      row={(item) => <OptionChip option={options.find((o) => o.name === item.id) ?? { name: item.id }} />}
      onPick={pick}
      onCreate={pick}
      createLabel={(name) => (
        <>
          <span className="shrink-0 text-ink-2">{t("db.option.create")}</span>
          <OptionChip option={{ name, color: OPTION_COLORS[options.length % OPTION_COLORS.length] }} />
        </>
      )}
    />
  );
}

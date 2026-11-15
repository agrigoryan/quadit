import { t } from "@/lib/i18n";
import { OptionChip, optionsOf } from "@/docs/db/options";
import { type DBProperty, OPTION_COLORS } from "@/types/docs";
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
  // A name made here is an option once the value is saved; until then (a form not yet sent) it is listed as picked.
  const names = [...options.map((o) => o.name), ...value.filter((v) => !options.some((o) => o.name === v))];

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
      items={names.map((name) => ({ id: name, label: name }))}
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

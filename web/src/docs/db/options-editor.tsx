import { type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { renameOption, updateProperty } from "@/docs/db/actions";
import { ColorDot, optionsOf } from "@/docs/db/options";
import { type DBProperty, OPTION_COLORS } from "@/types/docs";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";

const colorName = (color: string): string =>
  ({
    gray: t("db.color.gray"),
    blue: t("db.color.blue"),
    green: t("db.color.green"),
    yellow: t("db.color.yellow"),
    orange: t("db.color.orange"),
    red: t("db.color.red"),
    purple: t("db.color.purple"),
    pink: t("db.color.pink"),
  })[color] ?? color;

/** The options of a select property: rename, recolour, remove, add. */
export function OptionsEditor({ prop }: { prop: DBProperty }) {
  const options = optionsOf(prop);
  const [fresh, setFresh] = useState("");
  const save = (next: typeof options) => updateProperty(prop.id, { config: { ...prop.config, options: next } });

  function add(e: FormEvent) {
    e.preventDefault();
    const name = fresh.trim();
    if (!name || options.some((o) => o.name === name)) return;
    save([...options, { name, color: OPTION_COLORS[options.length % OPTION_COLORS.length] }]);
    setFresh("");
  }

  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-1 pb-0.5 text-xs font-medium text-ink-3">{t("db.options")}</p>
      {options.map((o) => (
        <div key={o.name} className="group flex h-7 items-center gap-1 rounded-sm px-1 hover:bg-hover">
          <Menu>
            <MenuTrigger
              aria-label={t("db.option.color", { name: o.name })}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-press"
            >
              <ColorDot color={o.color} />
            </MenuTrigger>
            <MenuContent className="min-w-32">
              {OPTION_COLORS.map((color) => (
                <MenuItem
                  key={color}
                  icon={<ColorDot color={color} />}
                  onSelect={() => save(options.map((x) => (x.name === o.name ? { ...x, color } : x)))}
                >
                  {colorName(color)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <input
            key={o.name}
            defaultValue={o.name}
            aria-label={t("db.option.rename", { name: o.name })}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (!name || name === o.name) {
                e.target.value = o.name;
              } else if (options.some((x) => x.name === name)) {
                // Two options cannot share a name; the server would refuse it too.
                toast.error(t("db.option.taken", { name }));
                e.target.value = o.name;
              } else {
                renameOption(prop, o.name, name);
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-6 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none focus:bg-surface focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            aria-label={t("db.option.remove", { name: o.name })}
            onClick={() => save(options.filter((x) => x.name !== o.name))}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-press hover:text-ink focus-visible:opacity-100"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
      <form onSubmit={add} className="px-1 pt-0.5">
        <input
          value={fresh}
          onChange={(e) => setFresh(e.target.value)}
          placeholder={t("db.option.add")}
          aria-label={t("db.option.add")}
          className="h-7 w-full rounded-sm border border-line bg-surface px-2 text-sm outline-none focus:border-accent"
        />
      </form>
    </div>
  );
}

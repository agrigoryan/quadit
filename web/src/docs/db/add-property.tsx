import type { ReactNode } from "react";
import { createProperty } from "@/docs/db/actions";
import { PropIcon, propTypeName } from "@/docs/db/prop-meta";
import { PROPERTY_TYPES, type PropertyType } from "@/docs/types";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/ui/menu";
import { t } from "@/lib/i18n";

interface Props {
  databaseId: string;
  /** The button that opens the list of types. */
  children: ReactNode;
  /** Told the new property's id, to open its settings. */
  onCreated?: (id: string) => void;
  align?: "start" | "end";
}

/** Pick a type and the property is there, named after its type; its settings open next. */
export function AddPropertyMenu({ databaseId, children, onCreated, align = "start" }: Props) {
  const add = (type: PropertyType) => {
    const id = createProperty(databaseId, propTypeName(type), type);
    // After the menu has gone: its closing would otherwise take the focus, and the settings with it.
    setTimeout(() => onCreated?.(id), 0);
  };
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent
        align={align}
        className="max-h-[70dvh] overflow-y-auto"
        onCloseAutoFocus={(e) => onCreated && e.preventDefault()}
      >
        <MenuLabel>{t("db.prop.pickType")}</MenuLabel>
        {PROPERTY_TYPES.map((type) => (
          <MenuItem key={type} icon={<PropIcon type={type} className="size-4 text-ink-2" />} onSelect={() => add(type)}>
            {propTypeName(type)}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

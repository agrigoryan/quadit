import { useState } from "react";
import { ArrowLeft, ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { rankBetween } from "@/lib/rank";
import { createView, deleteView, updateView } from "@/docs/db/actions";
import { VIEW_ICONS, viewTypeName } from "@/docs/db/prop-meta";
import { type DBView, VIEW_TYPES, type ViewType } from "@/lib/types-docs";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu";

interface Props {
  databaseId: string;
  views: DBView[];
  active: DBView | undefined;
  onPick: (viewId: string) => void;
}

const tabBase =
  "flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2 text-sm font-medium transition-colors [&>svg]:size-3.5";
const tab = `${tabBase} border-transparent text-ink-2 hover:text-ink`;
const tabOn = `${tabBase} border-accent text-ink`;

/**
 * A database's views as tabs. Click the open tab for its menu: rename,
 * change how it shows, move it, delete it. The plus adds a view.
 */
export function ViewTabs({ databaseId, views, active, onPick }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);

  /** Swaps a view with its neighbour by giving it a rank on the other side. */
  function shift(view: DBView, by: -1 | 1) {
    const at = views.indexOf(view);
    const to = at + by;
    if (to < 0 || to >= views.length) return;
    const [above, below] = by < 0 ? [views[to - 1], views[to]] : [views[to], views[to + 1]];
    updateView(view.id, { rank: rankBetween(above?.rank, below?.rank) });
  }

  function add(type: ViewType) {
    const taken = new Set(views.map((v) => v.name));
    let name = viewTypeName(type);
    for (let n = 2; taken.has(name); n++) name = `${viewTypeName(type)} ${n}`;
    onPick(createView(databaseId, type, name));
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <div
        role="tablist"
        aria-label={t("db.views")}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar"
      >
        {views.map((view) => {
          const Icon = VIEW_ICONS[view.type] ?? VIEW_ICONS.table;
          const on = view.id === active?.id;
          if (renaming === view.id) {
            return (
              <input
                key={view.id}
                autoFocus
                defaultValue={view.name}
                aria-label={t("db.view.rename")}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== view.name) updateView(view.id, { name });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                className="h-7 w-32 shrink-0 rounded-md border border-accent bg-surface px-2 text-sm outline-none ring-2 ring-accent/25"
              />
            );
          }
          if (!on) {
            return (
              <button
                key={view.id}
                type="button"
                role="tab"
                aria-selected={false}
                className={tab}
                onClick={() => onPick(view.id)}
              >
                <Icon aria-hidden />
                {view.name}
              </button>
            );
          }
          return (
            <Menu key={view.id}>
              <MenuTrigger role="tab" aria-selected className={tabOn}>
                <Icon aria-hidden />
                {view.name}
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Pencil />} onSelect={() => setRenaming(view.id)}>
                  {t("db.view.rename")}
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>{t("db.view.showAs")}</MenuLabel>
                {VIEW_TYPES.map((type) => {
                  const TypeIcon = VIEW_ICONS[type];
                  return (
                    <MenuItem
                      key={type}
                      icon={<TypeIcon />}
                      onSelect={() => type !== view.type && updateView(view.id, { type })}
                      className={cx(type === view.type && "bg-hover")}
                    >
                      {viewTypeName(type)}
                    </MenuItem>
                  );
                })}
                <MenuSeparator />
                <MenuItem icon={<ArrowLeft />} disabled={views[0]?.id === view.id} onSelect={() => shift(view, -1)}>
                  {t("db.view.moveLeft")}
                </MenuItem>
                <MenuItem
                  icon={<ArrowRight />}
                  disabled={views[views.length - 1]?.id === view.id}
                  onSelect={() => shift(view, 1)}
                >
                  {t("db.view.moveRight")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 />} disabled={views.length < 2} onSelect={() => deleteView(view.id)}>
                  {t("db.view.delete")}
                </MenuItem>
              </MenuContent>
            </Menu>
          );
        })}
      </div>
      <Menu>
        <MenuTrigger
          aria-label={t("db.view.add")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink data-[state=open]:bg-hover"
        >
          <Plus className="size-4" aria-hidden />
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{t("db.view.add")}</MenuLabel>
          {VIEW_TYPES.map((type) => {
            const TypeIcon = VIEW_ICONS[type];
            return (
              <MenuItem key={type} icon={<TypeIcon />} onSelect={() => add(type)}>
                {viewTypeName(type)}
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>
    </div>
  );
}

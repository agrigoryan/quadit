// A property's settings, in a popover from its name: rename, change its
// type, set what the type needs (options, the database a relation points
// into, a rollup's source, a formula), hide it in this view, delete it.

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EyeOff, Sigma, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { docTitle, useDocs, useProperties } from "@/docs/data";
import { deleteProperty, freeName, setViewConfig, updateProperty } from "@/docs/db/actions";
import { FormulaEditor } from "@/docs/db/formula-editor";
import { OptionsEditor } from "@/docs/db/options-editor";
import { PropIcon, propTypeName } from "@/docs/db/prop-meta";
import { ensureDatabase } from "@/docs/db/use-table";
import { type DBProperty, type DBView, type PropConfig, PROPERTY_TYPES, type PropertyType } from "@/docs/types";
import { Button } from "@/ui/button";
import { Select } from "@/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

const ROLLUP_FNS = ["count", "sum", "avg", "min", "max", "percent_checked", "values"] as const;
const rollupName = (fn: string): string =>
  ({
    count: t("db.rollup.count"),
    sum: t("db.rollup.sum"),
    avg: t("db.rollup.avg"),
    min: t("db.rollup.min"),
    max: t("db.rollup.max"),
    percent_checked: t("db.rollup.percent_checked"),
    values: t("db.rollup.values"),
  })[fn] ?? fn;

const wide = { className: "w-full [&>span]:flex-1", size: "md" as const };

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="px-1 text-xs font-medium text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function RelationConfig({ prop, save }: { prop: DBProperty; save: (c: PropConfig) => void }) {
  const docs = useDocs();
  const items = useMemo(
    () =>
      Object.values(docs)
        .filter((d) => d.kind === "database" && !d.deleted_at)
        .map((d) => ({ id: d.id, label: docTitle(d) })),
    [docs],
  );
  return (
    <Labeled label={t("db.relation.database")}>
      <Select label={t("db.relation.database")} placeholder={t("db.relation.pick")} items={items} value={prop.config?.database} onPick={(database) => save({ database })} buttonProps={wide} />
    </Labeled>
  );
}

function RollupConfig({ prop, save }: { prop: DBProperty; save: (c: PropConfig) => void }) {
  const own = useProperties(prop.database_id);
  const relations = own.filter((p) => p.type === "relation");
  const rel = relations.find((p) => p.id === prop.config?.relation || p.name === prop.config?.relation);
  const targetDb = rel?.config?.database;
  useEffect(() => ensureDatabase(targetDb), [targetDb]);
  const theirs = useProperties(targetDb);
  const cfg = prop.config ?? {};
  // A rollup made through the API may name its target instead of giving its id.
  const target = theirs.find((p) => p.id === cfg.target || p.name.toLowerCase() === cfg.target?.toLowerCase());
  return (
    <>
      <Labeled label={t("db.rollup.relation")}>
        <Select
          label={t("db.rollup.relation")}
          placeholder={relations.length ? t("db.rollup.pickRelation") : t("db.rollup.noRelation")}
          items={relations.map((p) => ({ id: p.id, label: p.name }))}
          value={rel?.id}
          onPick={(relation) => save({ ...cfg, relation, target: undefined })}
          buttonProps={wide}
        />
      </Labeled>
      <Labeled label={t("db.rollup.target")}>
        <Select
          label={t("db.rollup.target")}
          items={[{ id: "", label: t("db.title") }, ...theirs.map((p) => ({ id: p.id, label: p.name, icon: <PropIcon type={p.type} /> }))]}
          value={target?.id ?? ""}
          onPick={(target) => save({ ...cfg, target: target || undefined })}
          buttonProps={wide}
        />
      </Labeled>
      <Labeled label={t("db.rollup.fn")}>
        <Select label={t("db.rollup.fn")} items={ROLLUP_FNS.map((fn) => ({ id: fn, label: rollupName(fn) }))} value={cfg.fn || "count"} onPick={(fn) => save({ ...cfg, fn })} buttonProps={wide} />
      </Labeled>
    </>
  );
}

interface EditorProps {
  prop: DBProperty;
  view?: DBView;
  onClose: () => void;
  onFormula: () => void;
}

function PropertyEditor({ prop, view, onClose, onFormula }: EditorProps) {
  const save = (config: PropConfig) => updateProperty(prop.id, { config });
  const rename = (raw: string) => {
    const name = raw.trim();
    if (name && name !== prop.name) updateProperty(prop.id, { name: freeName(prop.database_id, name, prop.id) });
  };
  return (
    <div className="flex w-64 flex-col gap-2.5 p-2">
      <input
        autoFocus
        defaultValue={prop.name}
        aria-label={t("db.prop.name")}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => rename(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          rename(e.currentTarget.value);
          onClose();
        }}
        className="h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
      <Labeled label={t("db.prop.type")}>
        <Select
          label={t("db.prop.type")}
          items={PROPERTY_TYPES.map((type) => ({ id: type, label: propTypeName(type), icon: <PropIcon type={type} /> }))}
          value={prop.type}
          onPick={(type) => type !== prop.type && updateProperty(prop.id, { type: type as PropertyType })}
          buttonProps={wide}
        />
      </Labeled>
      {(prop.type === "select" || prop.type === "multi_select") && <OptionsEditor prop={prop} />}
      {prop.type === "relation" && <RelationConfig prop={prop} save={save} />}
      {prop.type === "rollup" && <RollupConfig prop={prop} save={save} />}
      {prop.type === "formula" && (
        <div className="flex flex-col gap-1.5">
          {prop.config?.formula && <code className="max-h-20 overflow-hidden rounded-sm bg-sunken px-2 py-1 font-mono text-xs break-words text-ink-2">{prop.config.formula}</code>}
          <Button onClick={onFormula}>
            <Sigma className="size-3.5" aria-hidden />
            {t("db.formula.edit")}
          </Button>
        </div>
      )}
      <div className="-mx-2 -mb-2 flex flex-col border-t border-line p-1">
        {view && (
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setViewConfig(view, { hidden: [...new Set([...(view.config?.hidden ?? []), prop.id])] });
              onClose();
            }}
          >
            <EyeOff className="size-4" aria-hidden />
            {t("db.prop.hide")}
          </Button>
        )}
        <Button
          variant="ghost"
          className="justify-start text-danger hover:text-danger"
          onClick={() => {
            deleteProperty(prop.id);
            onClose();
          }}
        >
          <Trash2 className="size-4" aria-hidden />
          {t("db.prop.delete")}
        </Button>
      </div>
    </div>
  );
}

interface PopoverProps {
  prop: DBProperty;
  view?: DBView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The property's name as a button: the popover opens from it. */
  children: ReactNode;
}

/** A property's settings, opening from its name. The formula editor is a dialog of its own. */
export function PropertyPopover({ prop, view, open, onOpenChange, children }: PopoverProps) {
  const [formula, setFormula] = useState(false);
  return (
    <>
      <Popover open={open && !formula} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent className="p-0">
          <PropertyEditor prop={prop} view={view} onClose={() => onOpenChange(false)} onFormula={() => setFormula(true)} />
        </PopoverContent>
      </Popover>
      {formula && (
        <FormulaEditor
          prop={prop}
          onClose={() => {
            setFormula(false);
            onOpenChange(false);
          }}
        />
      )}
    </>
  );
}

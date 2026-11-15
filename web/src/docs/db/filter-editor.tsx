// A view's conditions and its sort order, edited in popovers from the
// toolbar. Both are kept in the view's config, where the server reads them
// too (rows?view=).

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useMembers } from "@/lib/selectors";
import { setViewConfig } from "@/docs/db/actions";
import { optionsOf } from "@/docs/db/options";
import { PropIcon } from "@/docs/db/prop-meta";
import type { DBProperty, DBView, FilterOp, RowFilter, RowSort } from "@/types/docs";
import { Button } from "@/ui/button";
import { Select } from "@/ui/picker";

const TITLE = "title";

const opName = (op: FilterOp, date: boolean): string =>
  ({
    is: t("db.op.is"),
    is_not: t("db.op.is_not"),
    contains: t("db.op.contains"),
    gt: date ? t("db.op.after") : t("db.op.gt"),
    lt: date ? t("db.op.before") : t("db.op.lt"),
    empty: t("db.op.empty"),
    not_empty: t("db.op.not_empty"),
    checked: t("db.op.checked"),
    unchecked: t("db.op.unchecked"),
  })[op];

const DATES = ["date", "created_at", "updated_at"];

/** The conditions that make sense for a kind of property. */
function opsFor(prop: DBProperty | undefined): FilterOp[] {
  switch (prop?.type) {
    case "number":
    case "rollup":
      return ["is", "is_not", "gt", "lt", "empty", "not_empty"];
    case "select":
    case "multi_select":
    case "member":
    case "created_by":
      return ["is", "is_not", "empty", "not_empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "date":
    case "created_at":
    case "updated_at":
      return ["is", "gt", "lt", "empty", "not_empty"];
    case "relation":
      return ["empty", "not_empty"];
  }
  return ["contains", "is", "is_not", "empty", "not_empty"];
}

const NO_VALUE: FilterOp[] = ["empty", "not_empty", "checked", "unchecked"];
const field =
  "h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 text-sm outline-none focus:border-accent";

/** A text box that saves a moment after typing stops, so the view filters as you type without a change per key. */
function LazyInput({ value, onChange, type }: { value: string; onChange: (v: string) => void; type: string }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <input
      type={type}
      value={text}
      aria-label={t("db.filter.value")}
      placeholder={t("db.filter.value")}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange(next), 350);
      }}
      className={field}
    />
  );
}

function ValueInput({
  prop,
  filter,
  onChange,
}: {
  prop: DBProperty | undefined;
  filter: RowFilter;
  onChange: (value: unknown) => void;
}) {
  const members = useMembers();
  const small = { size: "md" as const, className: "min-w-0 flex-1 [&>span]:flex-1" };
  if (prop?.type === "select" || prop?.type === "multi_select") {
    return (
      <Select
        label={t("db.filter.value")}
        placeholder={t("db.filter.pick")}
        items={optionsOf(prop).map((o) => ({ id: o.name, label: o.name }))}
        value={typeof filter.value === "string" ? filter.value : undefined}
        onPick={onChange}
        buttonProps={small}
      />
    );
  }
  if (prop?.type === "member" || prop?.type === "created_by") {
    // The value compared is the handle a cell shows, as on the server.
    return (
      <Select
        label={t("db.filter.value")}
        placeholder={t("db.filter.pick")}
        items={members.map((m) => ({ id: `@${m.handle}`, label: m.name }))}
        value={typeof filter.value === "string" ? filter.value : undefined}
        onPick={onChange}
        buttonProps={small}
      />
    );
  }
  const numeric = prop?.type === "number" || prop?.type === "rollup";
  const type = numeric ? "number" : prop?.type === "date" ? "date" : "text";
  // A value typed or picked here is a string; one read back from the page may be a number or a boolean.
  const value = filter.value;
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return (
    <LazyInput
      key={`${filter.prop}:${type}`}
      type={type}
      value={text}
      onChange={(v) => onChange(numeric && v !== "" && Number.isFinite(Number(v)) ? Number(v) : v)}
    />
  );
}

const propItems = (props: DBProperty[]) => [
  { id: TITLE, label: t("db.title") },
  ...props.map((p) => ({ id: p.id, label: p.name, icon: <PropIcon type={p.type} /> })),
];

export function FilterEditor({ view, props }: { view: DBView; props: DBProperty[] }) {
  const filters = view.config?.filters ?? [];
  const save = (next: RowFilter[]) => setViewConfig(view, { filters: next.length ? next : undefined });
  const patch = (i: number, fields: Partial<RowFilter>) =>
    save(filters.map((f, j) => (j === i ? { ...f, ...fields } : f)));
  return (
    <div className="flex w-[min(30rem,calc(100vw-1rem))] flex-col gap-1.5 p-2">
      {filters.length === 0 && <p className="px-1 py-1 text-sm text-ink-2">{t("db.filter.none")}</p>}
      {filters.map((f, i) => {
        const prop = props.find((p) => p.id === f.prop);
        const ops = opsFor(prop);
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <Select
              label={t("db.filter.prop")}
              items={propItems(props)}
              value={f.prop}
              onPick={(id) => {
                const nextOps = opsFor(props.find((p) => p.id === id));
                patch(i, { prop: id, op: nextOps.includes(f.op) ? f.op : nextOps[0], value: undefined });
              }}
              buttonProps={{ className: "w-32 [&>span]:flex-1" }}
            />
            <Select
              label={t("db.filter.op")}
              items={ops.map((op) => ({ id: op, label: opName(op, DATES.includes(prop?.type ?? "")) }))}
              value={f.op}
              onPick={(op) => patch(i, { op: op as FilterOp })}
              buttonProps={{ className: "w-32 [&>span]:flex-1" }}
            />
            {!NO_VALUE.includes(f.op) && (
              <ValueInput prop={prop} filter={f} onChange={(value) => patch(i, { value })} />
            )}
            <button
              type="button"
              aria-label={t("db.filter.remove")}
              onClick={() => save(filters.filter((_, j) => j !== i))}
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => save([...filters, { prop: TITLE, op: "contains" }])}
      >
        <Plus className="size-3.5" aria-hidden />
        {t("db.filter.add")}
      </Button>
    </div>
  );
}

export function SortEditor({ view, props }: { view: DBView; props: DBProperty[] }) {
  const sorts = view.config?.sorts ?? [];
  const save = (next: RowSort[]) => setViewConfig(view, { sorts: next.length ? next : undefined });
  const patch = (i: number, fields: Partial<RowSort>) => save(sorts.map((s, j) => (j === i ? { ...s, ...fields } : s)));
  const unused = [TITLE, ...props.map((p) => p.id)].find((id) => !sorts.some((s) => s.prop === id)) ?? TITLE;
  return (
    <div className="flex w-[min(22rem,calc(100vw-1rem))] flex-col gap-1.5 p-2">
      {sorts.length === 0 && <p className="px-1 py-1 text-sm text-ink-2">{t("db.sort.none")}</p>}
      {sorts.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select
            label={t("db.filter.prop")}
            items={propItems(props)}
            value={s.prop}
            onPick={(prop) => patch(i, { prop })}
            buttonProps={{ className: "min-w-0 flex-1 [&>span]:flex-1" }}
          />
          <Button onClick={() => patch(i, { desc: !s.desc })} className="w-32 justify-start">
            {s.desc ? <ArrowDown className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />}
            {s.desc ? t("db.sort.desc") : t("db.sort.asc")}
          </Button>
          <button
            type="button"
            aria-label={t("db.sort.remove")}
            onClick={() => save(sorts.filter((_, j) => j !== i))}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => save([...sorts, { prop: unused }])}>
        <Plus className="size-3.5" aria-hidden />
        {t("db.sort.add")}
      </Button>
    </div>
  );
}

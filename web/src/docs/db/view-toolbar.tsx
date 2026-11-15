import type { ReactNode } from "react";
import { ArrowUpDown, Eye, EyeOff, ListFilter, Plus, SlidersHorizontal } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatNumber, t } from "@/lib/i18n";
import { setViewConfig } from "@/docs/db/actions";
import { AddPropertyMenu } from "@/docs/db/add-property";
import { FilterEditor, SortEditor } from "@/docs/db/filter-editor";
import { formProps } from "@/docs/db/form-view";
import { isComputed, PropIcon } from "@/docs/db/prop-meta";
import { shownProps } from "@/docs/db/use-table";
import type { DBProperty, DBView, ViewConfig } from "@/lib/types-docs";
import { Button } from "@/ui/button";
import { Select } from "@/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

interface Props {
  view: DBView;
  props: DBProperty[];
}

interface ToolbarProps extends Props {
  /** Nothing to show: every button here changes the view. */
  readOnly: boolean;
}

function ToolButton({
  icon,
  label,
  count,
  children,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          className={cx("max-md:px-1.5", !!count && "text-accent-text")}
        >
          {icon}
          <span className="max-lg:hidden">{label}</span>
          {!!count && <span className="tnum">{formatNumber(count)}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={label} className="p-0">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Which properties a view shows. For a form: which it asks for. */
function PropertyList({ view, props }: Props) {
  const form = view.type === "form";
  const all = form ? props.filter((p) => !isComputed(p)) : shownProps(props, view, true);
  const asked = new Set(formProps(props, view).map((p) => p.id));
  const hidden = new Set(view.config?.hidden ?? []);
  const isOn = (p: DBProperty) => (form ? asked.has(p.id) : !hidden.has(p.id));
  function toggle(p: DBProperty) {
    if (form) {
      const next = all.filter((q) => (q.id === p.id ? !asked.has(q.id) : asked.has(q.id))).map((q) => q.id);
      setViewConfig(view, { form_props: next });
    } else {
      const next = hidden.has(p.id) ? [...hidden].filter((id) => id !== p.id) : [...hidden, p.id];
      setViewConfig(view, { hidden: next.length ? next : undefined });
    }
  }
  return (
    <div className="flex max-h-[60dvh] w-64 flex-col overflow-y-auto p-1">
      {all.length === 0 && <p className="px-2 py-2 text-sm text-ink-2">{t("db.prop.none")}</p>}
      {all.map((p) => (
        <button
          key={p.id}
          type="button"
          role="switch"
          aria-checked={isOn(p)}
          onClick={() => toggle(p)}
          className={cx(
            "flex h-7 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-hover",
            !isOn(p) && "text-ink-3",
          )}
        >
          <PropIcon type={p.type} />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          {isOn(p) ? <Eye className="size-4 text-ink-2" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
        </button>
      ))}
      <div className="-mx-1 mt-1 -mb-1 border-t border-line p-1">
        <AddPropertyMenu databaseId={view.database_id}>
          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Plus className="size-4" aria-hidden />
            {t("db.prop.add")}
          </button>
        </AddPropertyMenu>
      </div>
    </div>
  );
}

/** A picker for the property a view is laid out by: the board's columns, the calendar's date. */
function LayoutPick({
  view,
  props,
  field,
  type,
  label,
  fallback = 0,
}: Props & { field: keyof ViewConfig; type: string; label: string; fallback?: number }) {
  const options = props.filter((p) => p.type === type);
  if (options.length === 0) return null;
  // Until one is chosen the view goes by the first that fits (the second, for a timeline's end).
  const current = options.find((p) => p.id === view.config?.[field]) ?? options[fallback] ?? options[0];
  return (
    <Select
      label={label}
      prefix={label}
      items={options.map((p) => ({ id: p.id, label: p.name }))}
      value={current?.id}
      placeholder="—"
      onPick={(id) => setViewConfig(view, { [field]: id })}
      align="end"
      buttonProps={{ variant: "ghost", size: "sm", className: "max-w-44 max-md:hidden" }}
    />
  );
}

/** The buttons beside the tabs: what the open view filters by, sorts by, shows, and is laid out by. */
export function ViewToolbar({ view, props, readOnly }: ToolbarProps) {
  if (readOnly) return null;
  const filters = view.config?.filters?.length ?? 0;
  const sorts = view.config?.sorts?.length ?? 0;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {view.type === "board" && (
        <LayoutPick view={view} props={props} field="group_by" type="select" label={t("db.board.groupBy")} />
      )}
      {view.type === "calendar" && (
        <LayoutPick view={view} props={props} field="date_prop" type="date" label={t("db.calendar.by")} />
      )}
      {view.type === "timeline" && (
        <>
          <LayoutPick view={view} props={props} field="date_prop" type="date" label={t("db.timeline.start")} />
          <LayoutPick
            view={view}
            props={props}
            field="end_prop"
            type="date"
            label={t("db.timeline.end")}
            fallback={1}
          />
        </>
      )}
      {view.type !== "form" && (
        <>
          <ToolButton icon={<ListFilter className="size-3.5" aria-hidden />} label={t("db.filter")} count={filters}>
            <FilterEditor view={view} props={props} />
          </ToolButton>
          <ToolButton icon={<ArrowUpDown className="size-3.5" aria-hidden />} label={t("db.sort")} count={sorts}>
            <SortEditor view={view} props={props} />
          </ToolButton>
        </>
      )}
      {view.type !== "timeline" && view.type !== "calendar" && (
        <ToolButton
          icon={<SlidersHorizontal className="size-3.5" aria-hidden />}
          label={view.type === "form" ? t("db.form.fields") : t("db.props")}
        >
          <PropertyList view={view} props={props} />
        </ToolButton>
      )}
    </div>
  );
}

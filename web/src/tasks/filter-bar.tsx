import { useState } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Project } from "@/lib/types";
import { FILTER_LABEL, type FilterKind, useFilterOptions } from "@/tasks/filter-options";
import { countFilters, emptyFilters, type Filters, LIST_KEYS, type ListFilterKey } from "@/tasks/filters";
import { createLabel, createLabelText, type ManageLink, useManageLinks } from "@/tasks/manage";
import { Button } from "@/ui/button";
import { Picker, type PickerItem, PickerList } from "@/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** The project in view; without one, filters that belong to a project are not offered. */
  project: Project | undefined;
}

/** The values picked for one filter, as picker ids. */
function picked(f: Filters, kind: FilterKind): string[] {
  if (kind === "openDecision") return [];
  if (kind === "waitingOn") return f.waitingOn ? [f.waitingOn] : [];
  return f[kind].map(String);
}

/** Toggles one value of one filter. */
function toggle(f: Filters, kind: Exclude<FilterKind, "openDecision">, id: string): Filters {
  if (kind === "waitingOn") return { ...f, waitingOn: f.waitingOn === id ? "" : id };
  if (kind === "priority") {
    const n = Number(id);
    return { ...f, priority: f.priority.includes(n) ? f.priority.filter((p) => p !== n) : [...f.priority, n] };
  }
  const list = f[kind] as string[];
  return { ...f, [kind]: list.includes(id) ? list.filter((v) => v !== id) : [...list, id] };
}

function clear(f: Filters, kind: FilterKind): Filters {
  if (kind === "openDecision") return { ...f, openDecision: false };
  if (kind === "waitingOn") return { ...f, waitingOn: "" };
  return { ...f, [kind]: [] };
}

/** What a filter's list offers besides its values: making a label, the way to where labels and statuses are kept. */
interface Extra {
  onCreate?: (name: string) => void;
  createLabel?: (name: string) => string;
  manage?: ManageLink;
}

/** An active filter: what it is set to, a click to change it, a cross to drop it. */
function FilterChip({
  kind,
  items,
  filters,
  onChange,
  extra,
}: {
  kind: FilterKind;
  items: PickerItem[];
  filters: Filters;
  onChange: (f: Filters) => void;
  extra?: Extra;
}) {
  const values = picked(filters, kind);
  const first = items.find((i) => i.id === values[0]);
  const name = t(FILTER_LABEL[kind]);
  if (kind === "openDecision") {
    return (
      <span className="flex h-6 shrink-0 items-stretch rounded-sm border border-line bg-surface text-xs">
        <span className="flex items-center pr-1 pl-2 font-medium text-ink">{name}</span>
        <RemoveFilter name={name} onClick={() => onChange(clear(filters, kind))} />
      </span>
    );
  }
  return (
    <span className="flex h-6 shrink-0 items-stretch rounded-sm border border-line bg-surface text-xs">
      <Picker
        items={items}
        value={values}
        multiple={kind !== "waitingOn"}
        label={name}
        placeholder={name}
        onPick={(id) => onChange(toggle(filters, kind, id))}
        {...extra}
      >
        <button
          type="button"
          className="flex h-full min-w-0 items-center gap-1.5 rounded-l-sm pr-1 pl-2 hover:bg-hover"
        >
          <span className="text-ink-3">{name}</span>
          <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
            {values.length === 1 && first?.icon}
            <span className="max-w-32 truncate">
              {values.length === 1 ? (first?.label ?? "") : t("filter.any", { n: values.length })}
            </span>
          </span>
        </button>
      </Picker>
      <RemoveFilter name={name} onClick={() => onChange(clear(filters, kind))} />
    </span>
  );
}

function RemoveFilter({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("filter.remove", { name })}
      onClick={onClick}
      className="flex w-5 items-center justify-center rounded-r-sm border-l border-line text-ink-3 hover:bg-hover hover:text-ink"
    >
      <X className="size-3" />
    </button>
  );
}

/** Text search, the active filters as chips, and a button to add another. */
export function FilterBar({ filters, onChange, project }: Props) {
  const options = useFilterOptions(project);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Exclude<FilterKind, "openDecision"> | null>(null);

  const kinds: FilterKind[] = [
    "assignee",
    ...(project ? (["status"] as const) : []),
    "category",
    "label",
    "priority",
    "epic",
    ...(project?.settings?.cycles ? (["cycle"] as const) : []),
    "waitingOn",
    "openDecision",
  ];
  const active: FilterKind[] = [
    ...LIST_KEYS.filter((k: ListFilterKey) => filters[k].length > 0),
    ...(filters.waitingOn ? (["waitingOn"] as const) : []),
    ...(filters.openDecision ? (["openDecision"] as const) : []),
  ];
  const count = countFilters(filters);
  const manage = useManageLinks(project?.id);
  const extras: Partial<Record<FilterKind, Extra>> = {
    // A label made here is filtered by at once, ready to be put on tasks.
    label: {
      onCreate: (name) => onChange(toggle(filters, "label", createLabel(project?.id, name))),
      createLabel: createLabelText,
      manage: manage.labels,
    },
    status: { manage: manage.statuses },
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label className="flex h-6 w-40 shrink-0 items-center gap-1.5 rounded-sm border border-line bg-surface px-1.5 focus-within:border-accent max-sm:w-32">
        <Search className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <input
          type="search"
          value={filters.text}
          onChange={(e) => onChange({ ...filters, text: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
          placeholder={t("filter.text")}
          aria-label={t("filter.text")}
          className="w-full min-w-0 bg-transparent text-xs outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </label>

      {active.map((kind) => (
        <FilterChip
          key={kind}
          kind={kind}
          items={kind === "openDecision" ? [] : options[kind]}
          filters={filters}
          onChange={onChange}
          extra={extras[kind]}
        />
      ))}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setStage(null);
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="shrink-0">
            <ListFilter className="size-3.5" aria-hidden />
            {t("filter.add")}
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label={t(stage === null ? "filter.add" : FILTER_LABEL[stage])} className="p-0">
          {stage === null ? (
            <PickerList
              label={t("filter.add")}
              placeholder={t("filter.add")}
              items={kinds.map((k) => ({ id: k, label: t(FILTER_LABEL[k]) }))}
              value={active}
              onPick={(id) => {
                const kind = id as FilterKind;
                if (kind === "openDecision") {
                  onChange({ ...filters, openDecision: !filters.openDecision });
                  setOpen(false);
                } else setStage(kind);
              }}
            />
          ) : (
            <PickerList
              key={stage}
              label={t(FILTER_LABEL[stage])}
              placeholder={t(FILTER_LABEL[stage])}
              items={options[stage]}
              value={picked(filters, stage)}
              onPick={(id) => {
                onChange(toggle(filters, stage, id));
                if (stage === "waitingOn") setOpen(false);
              }}
              {...extras[stage]}
              manage={(() => {
                const link = extras[stage]?.manage;
                return (
                  link && {
                    label: link.label,
                    onSelect: () => {
                      setOpen(false);
                      link.onSelect();
                    },
                  }
                );
              })()}
            />
          )}
        </PopoverContent>
      </Popover>

      {(count > 0 || filters.text) && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onChange(emptyFilters)}>
          {t("filter.clear")}
        </Button>
      )}
    </div>
  );
}

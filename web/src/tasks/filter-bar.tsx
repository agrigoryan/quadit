import { useState } from "react";
import { useHotkeys } from "@/hooks/hotkeys";
import { ListFilter, Search, X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Project } from "@/types/core";
import { countFilters, emptyFilters, type Filters } from "@/tasks/filters";
import { useManageLinks } from "@/tasks/manage";
import { FILTERS } from "@/tasks/properties";
import { Button } from "@/ui/button";
import { Picker, type PickerAction, PickerList } from "@/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** The project in view; without one, filters that belong to a project are not offered. */
  project: Project | undefined;
}

/** One property a list can be filtered by (tasks/properties). */
type Filter = (typeof FILTERS)[number];

/** The "has an open question" filter, which is no property of the task: its id in the menu. */
const OPEN_DECISION = "openDecision";

/** Toggles one value of one filter. A filter of one value at a time takes the new one, or none when it was that. */
function toggle(f: Filters, { name, filter }: Filter, id: string): Filters {
  const now = f[name];
  const next =
    filter.holds === "one"
      ? now[0] === id
        ? []
        : [id]
      : now.includes(id)
        ? now.filter((v) => v !== id)
        : [...now, id];
  return { ...f, [name]: next };
}

/** What a filter's list offers besides its values: making one (a label), the way to where they are kept. */
function useExtras(p: Filter, filters: Filters, onChange: (f: Filters) => void, project: Project | undefined) {
  const links = useManageLinks(project?.id);
  const { make, manage } = p;
  return {
    // A label made here is filtered by at once, ready to be put on tasks.
    onCreate: make && ((name: string) => onChange(toggle(filters, p, make.run(project?.id, name)))),
    createLabel: make?.label,
    manage: manage && links[manage],
  };
}

interface ChipProps {
  property: Filter;
  filters: Filters;
  onChange: (f: Filters) => void;
  project: Project | undefined;
}

/** An active filter: what it is set to, a click to change it, a cross to drop it. */
function FilterChip({ property, filters, onChange, project }: ChipProps) {
  const { name, filter } = property;
  const items = filter.useOptions(project);
  const extras = useExtras(property, filters, onChange, project);
  const values = filters[name];
  const first = items.find((i) => i.id === values[0]);
  const title = filter.title();
  return (
    <span className="flex h-6 shrink-0 items-stretch rounded-sm border border-line bg-surface text-xs">
      <Picker
        items={items}
        value={values}
        multiple={filter.holds !== "one"}
        label={title}
        placeholder={title}
        onPick={(id) => onChange(toggle(filters, property, id))}
        {...extras}
      >
        <button
          type="button"
          className="flex h-full min-w-0 items-center gap-1.5 rounded-l-sm pr-1 pl-2 hover:bg-hover"
        >
          <span className="text-ink-3">{title}</span>
          <span className="flex min-w-0 items-center gap-1 font-medium text-ink">
            {values.length === 1 && first?.icon}
            <span className="max-w-32 truncate">
              {values.length === 1 ? (first?.label ?? "") : t("filter.any", { n: values.length })}
            </span>
          </span>
        </button>
      </Picker>
      <RemoveFilter name={title} onClick={() => onChange({ ...filters, [name]: [] })} />
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

/** One filter's values, in the "add a filter" popover once the filter is picked. */
function StageList({ property, filters, onChange, project, close }: ChipProps & { close: () => void }) {
  const { filter } = property;
  const extras = useExtras(property, filters, onChange, project);
  const title = filter.title();
  const link = extras.manage;
  // The list's own popover closes before going to where the values are kept.
  const manage: PickerAction | undefined = link && {
    label: link.label,
    onSelect: () => {
      close();
      link.onSelect();
    },
  };
  return (
    <PickerList
      label={title}
      placeholder={title}
      items={filter.useOptions(project)}
      value={filters[property.name]}
      onPick={(id) => {
        onChange(toggle(filters, property, id));
        if (filter.holds === "one") close();
      }}
      {...extras}
      manage={manage}
    />
  );
}

/** Text search, the active filters as chips, and a button to add another, which F presses. */
export function FilterBar({ filters, onChange, project }: Props) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Filter | null>(null);
  useHotkeys({
    f: (e) => {
      e.preventDefault(); // or the letter lands in the menu's search box
      setOpen(true);
    },
  });

  const offered = FILTERS.filter((p) => p.filter.offered?.(project) ?? true);
  const active = FILTERS.filter((p) => filters[p.name].length > 0);
  const count = countFilters(filters);

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

      {active.map((p) => (
        <FilterChip key={p.name} property={p} filters={filters} onChange={onChange} project={project} />
      ))}
      {filters.openDecision && (
        <span className="flex h-6 shrink-0 items-stretch rounded-sm border border-line bg-surface text-xs">
          <span className="flex items-center pr-1 pl-2 font-medium text-ink">{t("filter.openDecision")}</span>
          <RemoveFilter name={t("filter.openDecision")} onClick={() => onChange({ ...filters, openDecision: false })} />
        </span>
      )}

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
        <PopoverContent aria-label={stage === null ? t("filter.add") : stage.filter.title()} className="p-0">
          {stage === null ? (
            <PickerList
              label={t("filter.add")}
              placeholder={t("filter.add")}
              items={[
                ...offered.map((p) => ({ id: p.name, label: p.filter.title() })),
                { id: OPEN_DECISION, label: t("filter.openDecision") },
              ]}
              value={[...active.map((p) => p.name), ...(filters.openDecision ? [OPEN_DECISION] : [])]}
              onPick={(id) => {
                if (id === OPEN_DECISION) {
                  onChange({ ...filters, openDecision: !filters.openDecision });
                  setOpen(false);
                } else setStage(offered.find((p) => p.name === id) ?? null);
              }}
            />
          ) : (
            <StageList
              key={stage.name}
              property={stage}
              filters={filters}
              onChange={onChange}
              project={project}
              close={() => setOpen(false)}
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

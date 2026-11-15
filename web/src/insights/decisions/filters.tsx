// The controls over the decision log: a search box and four filters. Each
// filter's list shows how many decisions every choice would leave, given
// the other filters.

import { Search, X } from "lucide-react";
import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection, useProjects } from "@/lib/selectors";
import { nameOf } from "@/detail/data";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { type PickerItem, Select } from "@/ui/picker";
import { countBy, type Entry, type Filters, isFiltered, noFilters, STATES, type StateFilter } from "@/insights/decisions/data";

const ANY = "any";

interface Props {
  entries: Entry[];
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}

export function FilterBar({ entries, filters, onChange }: Props) {
  const projects = useProjects();
  const members = useCollection("members");
  const counts = useMemo(
    () => ({
      state: countBy(entries, filters, "state"),
      project: countBy(entries, filters, "project"),
      asked: countBy(entries, filters, "asked"),
      by: countBy(entries, filters, "by"),
    }),
    [entries, filters],
  );

  const stateItems: PickerItem[] = STATES.map((s) => ({ id: s, label: t(`declog.state.${s}`), hint: counts.state[s] ?? 0 }));
  const projectItems: PickerItem[] = [
    { id: ANY, label: t("ins.allProjects"), hint: counts.project.all ?? 0 },
    ...projects.map((p) => ({
      id: p.id,
      label: p.name,
      keywords: p.key,
      icon: <ProjectGlyph project={p} />,
      hint: counts.project[p.id] ?? 0,
    })),
  ];
  // Only people and agents who have been asked, or have answered, at least once.
  const people = (field: "asked" | "by"): PickerItem[] => {
    const ids = new Set<string>();
    for (const e of entries) {
      const id = field === "asked" ? e.decision.asked_id : e.decision.decided_by;
      if (id) ids.add(id);
    }
    const list = [...ids]
      .map((id) => members[id])
      .filter((m) => !!m)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [
      { id: ANY, label: t("declog.anyone"), hint: counts[field].all ?? 0 },
      ...list.map((m) => ({
        id: m.user_id,
        label: nameOf(m),
        keywords: `${m.name} ${m.handle}`,
        icon: <Avatar member={m} size="xs" />,
        hint: counts[field][m.user_id] ?? 0,
      })),
    ];
  };
  const pick = (field: "project" | "asked" | "by") => (id: string) => onChange({ [field]: id === ANY ? "" : id });
  const button = { className: "max-w-48 shrink-0 max-sm:h-9" };

  return (
    <div role="search" aria-label={t("declog.filters")} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1 basis-56 sm:max-w-80">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
        <Input
          type="search"
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
          placeholder={t("declog.search")}
          aria-label={t("declog.search")}
          className="h-7 pl-7 max-sm:h-9 max-sm:text-base [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:shrink-0 max-sm:basis-auto max-sm:px-4">
        <Select
          value={filters.state}
          prefix={t("declog.state")}
          items={stateItems}
          label={t("declog.state")}
          onPick={(id) => onChange({ state: id as StateFilter })}
          buttonProps={button}
        />
        <Select
          value={filters.project || ANY}
          prefix={t("declog.project")}
          items={projectItems}
          label={t("declog.project")}
          onPick={pick("project")}
          buttonProps={button}
        />
        <Select
          value={filters.asked || ANY}
          prefix={t("declog.asked")}
          items={people("asked")}
          label={t("declog.asked")}
          onPick={pick("asked")}
          buttonProps={button}
        />
        <Select
          value={filters.by || ANY}
          prefix={t("declog.by")}
          items={people("by")}
          label={t("declog.by")}
          onPick={pick("by")}
          buttonProps={button}
        />
        {isFiltered(filters) && (
          <Button variant="ghost" className="shrink-0 max-sm:h-9" onClick={() => onChange(noFilters)}>
            <X className="size-3.5" aria-hidden />
            {t("declog.clear")}
          </Button>
        )}
      </div>
    </div>
  );
}

// The decision log: every question asked on a task, with what was shown,
// what was picked and why, newest first; and beside it the standing
// preferences that answers have been turned into. All of it is read from
// the store, so it changes as decisions are asked and answered.

import { useMemo, useState } from "react";
import { MessageCircleQuestion, SearchX } from "lucide-react";
import { useSearchParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/lib/access";
import { useMe } from "@/lib/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { useAttachmentsBySubject } from "@/detail/data";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import {
  type Entry,
  type Filters,
  isFiltered,
  matches,
  noFilters,
  STATES,
  type StateFilter,
  useEntries,
  usePreferences,
} from "@/insights/decisions/data";
import { DecisionEntry } from "@/insights/decisions/entry";
import { FilterBar } from "@/insights/decisions/filters";
import { PreferenceDialog } from "@/insights/decisions/preference-dialog";
import { PreferenceList } from "@/insights/decisions/preferences";
import { count } from "@/insights/lib/amounts";
import { PageBar } from "@/insights/ui/panel";

const PAGE = 50;

type Pane = "log" | "prefs";
type Making = { entry?: Entry } | null;

/** Filters a link can carry: /decisions?state=open&q=boss. */
function fromAddress(params: URLSearchParams): Filters {
  const state = params.get("state") as StateFilter | null;
  return { ...noFilters, q: params.get("q") ?? "", state: state && STATES.includes(state) ? state : "all" };
}

export function DecisionLogPage() {
  usePageTitle(t("declog.title"));
  const me = useMe();
  const entries = useEntries();
  const prefs = usePreferences();
  const files = useAttachmentsBySubject("decision_option");
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => fromAddress(params));
  const [limit, setLimit] = useState(PAGE);
  const [pane, setPane] = useState<Pane>("log");
  const [making, setMaking] = useState<Making>(null);
  const canEdit = useCan().administer;

  const found = useMemo(() => entries.filter((e) => matches(e, filters)), [entries, filters]);
  const shown = found.slice(0, limit);
  const filtered = isFiltered(filters);

  function change(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setLimit(PAGE);
  }

  return (
    <div className="flex h-full flex-col">
      <PageBar className="pr-4 max-sm:py-2">
        <FilterBar entries={entries} filters={filters} onChange={change} />
        <p className="shrink-0 text-xs text-ink-2 tnum max-sm:hidden" aria-live="polite">
          {filtered
            ? t("declog.countOf", { n: found.length, total: entries.length })
            : t("declog.count", { n: entries.length })}
        </p>
      </PageBar>

      {/* Below a desktop width the log and the preferences take turns. */}
      <div role="tablist" aria-label={t("declog.pane")} className="flex shrink-0 border-b border-line px-2 lg:hidden">
        {(["log", "prefs"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={pane === id}
            onClick={() => setPane(id)}
            className={cx(
              "-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium",
              pane === id ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {t(`declog.pane.${id}`)}
            <span className="text-xs font-normal text-ink-3 tnum">
              {count(id === "log" ? found.length : prefs.active.length)}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cx("min-w-0 flex-1 overflow-y-auto pb-10", pane !== "log" && "max-lg:hidden")}>
          {found.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={<SearchX />}
                title={t("declog.emptyFiltered")}
                hint={t("declog.emptyFilteredHint")}
                action={<Button onClick={() => change(noFilters)}>{t("declog.clear")}</Button>}
              />
            ) : (
              <EmptyState icon={<MessageCircleQuestion />} title={t("declog.empty")} hint={t("declog.emptyHint")} />
            )
          ) : (
            <>
              <ul>
                {shown.map((entry) => (
                  <DecisionEntry
                    key={entry.decision.id}
                    entry={entry}
                    meId={me.user_id}
                    files={files}
                    preference={prefs.byDecision[entry.decision.id]}
                    canMake={canEdit}
                    onMake={(e) => setMaking({ entry: e })}
                  />
                ))}
              </ul>
              {found.length > shown.length && (
                <div className="flex justify-center py-3">
                  <Button onClick={() => setLimit((n) => n + PAGE)}>
                    {t("declog.showMore", { n: Math.min(PAGE, found.length - shown.length) })}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        <PreferenceList
          prefs={prefs}
          canEdit={canEdit}
          onAdd={() => setMaking({})}
          className={cx(
            "lg:w-84 lg:shrink-0 lg:border-l lg:border-line",
            pane === "prefs" ? "max-lg:flex-1" : "max-lg:hidden",
          )}
        />
      </div>

      {making && (
        <PreferenceDialog
          from={making.entry ? { decision: making.entry.decision, projectId: making.entry.task.project_id } : undefined}
          onClose={() => setMaking(null)}
        />
      )}
    </div>
  );
}

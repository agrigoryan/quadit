// The dashboard: where everything stands, on one page. What waits on the
// person looking comes first; the rest is the state of the work, the agents
// and the machinery. One request answers what only the server knows, and it
// is asked again (at most every two seconds) whenever the feed moves.

import { FolderKanban } from "lucide-react";
import { useSearchParams } from "react-router";
import { t } from "@/lib/i18n";
import { useProjectByKey, useProjects } from "@/lib/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { AgentsPanel } from "@/insights/dashboard/agents-panel";
import { DecisionsPanel } from "@/insights/dashboard/decisions-panel";
import { EpicsPanel } from "@/insights/dashboard/epics-panel";
import { StatusPanel, WaitsPanel, WeeklyPanel } from "@/insights/dashboard/flow-panels";
import { HealthPanel } from "@/insights/dashboard/health-panel";
import { WaitingPanel } from "@/insights/dashboard/waiting-panel";
import { useLive } from "@/insights/lib/live";
import type { Dashboard } from "@/insights/lib/types";
import { PageBar } from "@/insights/ui/panel";
import { ProjectGlyph } from "@/shell/sidebar";
import { Select } from "@/ui/picker";
import { Loading } from "@/ui/spinner";

const ALL = "all";

export function DashboardPage() {
  usePageTitle(t("nav.dashboard"));
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const project = useProjectByKey(params.get("project") ?? undefined);
  const { data, error, loading } = useLive<Dashboard>(project ? `/dashboard?project=${encodeURIComponent(project.key)}` : "/dashboard");

  const items = [
    { id: ALL, label: t("ins.allProjects"), icon: <FolderKanban className="size-3.5 text-ink-3" /> },
    ...projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, hint: p.key })),
  ];
  const pick = (id: string) => {
    const key = projects.find((p) => p.id === id)?.key;
    setParams(key ? { project: key } : {}, { replace: true });
  };

  return (
    <div className="flex h-full flex-col">
      <PageBar>
        <Select items={items} value={project?.id ?? ALL} onPick={pick} label={t("ins.project")} buttonProps={{ className: "max-w-56" }} />
        <span className="flex-1" />
        {error && (
          <p role="alert" className="text-xs text-danger">
            {t("ins.loadFailed", { why: error })}
          </p>
        )}
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="grid grid-cols-1 gap-px border-b border-line bg-line lg:grid-cols-12">
          <WaitingPanel projectId={project?.id} className="lg:col-span-7" />
          {loading && !data ? (
            <div className="bg-surface lg:col-span-5">
              <Loading />
            </div>
          ) : data ? (
            <>
              <AgentsPanel agents={data.agents} className="lg:col-span-5" />
              <EpicsPanel epics={data.epics} showProject={!project} className="lg:col-span-7" />
              <WaitsPanel rows={data.flow.waiting} className="lg:col-span-5" />
              <StatusPanel rows={data.flow.by_status} className="lg:col-span-5" />
              <WeeklyPanel weeks={data.flow.weekly} className="lg:col-span-7" />
              <DecisionsPanel decisions={data.recent_decisions} preferences={data.preferences} className="lg:col-span-7" />
              <HealthPanel health={data.health} className="lg:col-span-5" />
            </>
          ) : (
            <div className="bg-surface lg:col-span-5" />
          )}
        </div>
      </div>
    </div>
  );
}

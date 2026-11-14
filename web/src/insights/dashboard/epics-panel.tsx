// Epics and how far along each is: done, under way and the rest as one bar,
// with points, the target date and, when the server judges it at risk, why.

import { TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { daysUntil, formatDay } from "@/lib/time";
import type { EpicProgress } from "@/insights/lib/types";
import { Panel, PanelEmpty } from "@/insights/ui/panel";
import { Progress } from "@/insights/ui/progress";

/** The server gives the reason in its own words; known ones are translated. */
export function riskText(reason: string): string {
  return tMaybe(`ins.risk.${reason.replace(/[^a-z]+/gi, "_").toLowerCase()}`, reason);
}

function Row({ epic, showProject }: { epic: EpicProgress; showProject: boolean }) {
  const slug = useSlug();
  const late = !!epic.target_on && daysUntil(epic.target_on) < 0 && epic.state !== "done" && epic.done < epic.total;
  return (
    <li className="relative border-b border-line/70 px-4 py-2 hover:bg-hover">
      <div className="flex items-baseline gap-2 text-sm">
        <Link
          to={`/${slug}/p/${epic.project}/epics/${epic.id}`}
          className="min-w-0 truncate font-medium outline-none after:absolute after:inset-0 after:content-['']"
        >
          {epic.name}
        </Link>
        {showProject && <span className="shrink-0 text-xs text-ink-3 tnum">{epic.project}</span>}
        {epic.state !== "active" && (
          <span className="shrink-0 text-xs text-ink-3">{t(`epics.state.${epic.state}` as "epics.state.planned")}</span>
        )}
        <span className="flex-1" />
        {epic.target_on && (
          <span className={cx("shrink-0 text-xs tnum", late ? "font-medium text-danger" : "text-ink-3")}>
            {t("epics.target", { day: formatDay(epic.target_on) })}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <Progress done={epic.done} started={epic.started} total={epic.total} className="min-w-0 flex-1" />
        <span className="shrink-0 text-xs text-ink-2 tnum">
          {t("dash.epics.count", { done: epic.done, total: epic.total })}
          {!!epic.points && (
            <span className="text-ink-3">{t("dash.epics.points", { done: epic.points_done ?? 0, total: epic.points })}</span>
          )}
        </span>
      </div>
      {epic.at_risk && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-wait">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          {t("dash.epics.atRisk", { why: riskText(epic.at_risk) })}
        </p>
      )}
    </li>
  );
}

export function EpicsPanel({ epics, showProject, className }: { epics: EpicProgress[]; showProject: boolean; className?: string }) {
  const atRisk = epics.filter((e) => e.at_risk).length;
  return (
    <Panel
      title={t("nav.epics")}
      meta={atRisk > 0 ? <span className="text-xs font-medium text-wait">{t("dash.epics.riskCount", { n: atRisk })}</span> : undefined}
      className={className}
      flush
    >
      {epics.length === 0 ? (
        <PanelEmpty>{t("dash.epics.empty")}</PanelEmpty>
      ) : (
        <ul className="border-t border-line/70">
          {epics.map((epic) => (
            <Row key={epic.id} epic={epic} showProject={showProject} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

import { matchPath, useLocation } from "react-router";
import { AgentsPage } from "@/insights/agents/agents-page";
import { DashboardPage } from "@/insights/dashboard/dashboard-page";
import { DecisionLogPage } from "@/insights/decisions/decisions-page";
import { CyclePage } from "@/insights/plan/cycle-page";
import { EpicPage } from "@/insights/plan/epic-page";
import { TimelinePage } from "@/insights/timeline/timeline-page";

/**
 * The pages that show where things stand: the dashboard, agents, the
 * decision log, timelines and the detail pages of epics and cycles.
 * Mounted at /:ws/* after the shell's own routes. Loaded on demand.
 */
export default function InsightRoutes() {
  // The shell mounts this once per path in insights/paths.ts, and each of
  // those routes has already matched the whole address: a <Routes> in here
  // would be left with "/" and match nothing. So the page is picked by the
  // same patterns; :key and :id reach the pages through useParams as usual.
  const { pathname } = useLocation();
  const at = (path: string) => matchPath(`/:ws/${path}`, pathname) !== null;
  if (at("dashboard")) return <DashboardPage />;
  if (at("agents")) return <AgentsPage />;
  if (at("decisions")) return <DecisionLogPage />;
  if (at("p/:key/timeline")) return <TimelinePage />;
  if (at("p/:key/epics/:id")) return <EpicPage />;
  if (at("p/:key/cycles/:id")) return <CyclePage />;
  return null;
}

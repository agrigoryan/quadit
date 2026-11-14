import { Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { ComingPage } from "@/shell/placeholders";

/**
 * The pages that show where things stand: the dashboard, agents, the
 * decision log, timelines and the detail pages of epics and cycles.
 * Mounted at /:ws/* after the shell's own routes. Loaded on demand.
 */
export default function InsightRoutes() {
  return (
    <Routes>
      <Route path="dashboard" element={<ComingPage name={t("nav.dashboard")} />} />
    </Routes>
  );
}

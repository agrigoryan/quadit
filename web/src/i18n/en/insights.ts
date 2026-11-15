// Strings for the insights part of the app, one file per page (insights-*.ts),
// gathered here.

import { agentsStrings } from "@/i18n/en/insights-agents";
import { dashboardStrings } from "@/i18n/en/insights-dashboard";
import { decisionsStrings } from "@/i18n/en/insights-decisions";
import { planStrings } from "@/i18n/en/insights-plan";
import { coreStrings } from "@/i18n/en/insights-shared";
import { timelineStrings } from "@/i18n/en/insights-timeline";

export const insights = {
  ...coreStrings,
  ...dashboardStrings,
  ...agentsStrings,
  ...decisionsStrings,
  ...planStrings,
  ...timelineStrings,
};

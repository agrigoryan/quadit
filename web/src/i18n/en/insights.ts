// Strings for the insights part of the app. They are kept beside the pages
// that use them (insights/strings/*.ts) and gathered here.

import { agentsStrings } from "@/insights/strings/agents";
import { coreStrings } from "@/insights/strings/core";
import { dashboardStrings } from "@/insights/strings/dashboard";
import { decisionsStrings } from "@/insights/strings/decisions";
import { planStrings } from "@/insights/strings/plan";
import { timelineStrings } from "@/insights/strings/timeline";

export const insights = {
  ...coreStrings,
  ...dashboardStrings,
  ...agentsStrings,
  ...decisionsStrings,
  ...planStrings,
  ...timelineStrings,
};

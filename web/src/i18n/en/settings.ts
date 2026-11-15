// Strings for the settings part of the app, one file per page
// (settings-*.ts), and for signing in (auth.ts), gathered here.

import { authStrings } from "@/i18n/en/auth";
import { agentStrings } from "@/i18n/en/settings-agents";
import { automationStrings } from "@/i18n/en/settings-automation";
import { importStrings } from "@/i18n/en/settings-import";
import { meStrings } from "@/i18n/en/settings-me";
import { projectStrings } from "@/i18n/en/settings-projects";
import { secretStrings } from "@/i18n/en/settings-secrets";
import { sharedStrings } from "@/i18n/en/settings-shared";
import { workspaceStrings } from "@/i18n/en/settings-workspace";

export const settings = {
  ...sharedStrings,
  ...workspaceStrings,
  ...projectStrings,
  ...agentStrings,
  ...automationStrings,
  ...secretStrings,
  ...importStrings,
  ...meStrings,
  ...authStrings,
};

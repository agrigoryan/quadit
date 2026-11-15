// Strings for the settings part of the app. They are kept beside the pages
// that use them (settings/strings/*.ts, auth/strings.ts) and gathered here.

import { authStrings } from "@/auth/strings";
import { agentStrings } from "@/settings/strings/agents";
import { automationStrings } from "@/settings/strings/automation";
import { importStrings } from "@/settings/strings/import";
import { meStrings } from "@/settings/strings/me";
import { projectStrings } from "@/settings/strings/projects";
import { secretStrings } from "@/settings/strings/secrets";
import { sharedStrings } from "@/settings/strings/shared";
import { workspaceStrings } from "@/settings/strings/workspace";

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

// The English dictionary, one file per part of the app. A translation is
// another object with the same keys.

import { admin } from "@/i18n/en/admin";
import { common } from "@/i18n/en/common";
import { decisions } from "@/i18n/en/decisions";
import { detail } from "@/i18n/en/detail";
import { docs } from "@/i18n/en/docs";
import { insights } from "@/i18n/en/insights";
import { pages } from "@/i18n/en/pages";
import { push } from "@/i18n/en/push.gen";
import { settings } from "@/i18n/en/settings";
import { tasks } from "@/i18n/en/tasks";

export const en = {
  ...common,
  ...tasks,
  ...detail,
  ...decisions,
  ...pages,
  ...settings,
  ...docs,
  ...insights,
  ...admin,
  ...push,
};

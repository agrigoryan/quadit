// The English dictionary, one file per part of the app. A translation is
// another object with the same keys.

import { common } from "@/i18n/en/common";
import { decisions } from "@/i18n/en/decisions";
import { detail } from "@/i18n/en/detail";
import { pages } from "@/i18n/en/pages";
import { tasks } from "@/i18n/en/tasks";

export const en = { ...common, ...tasks, ...detail, ...decisions, ...pages };

// The pages of workspace settings, in the groups and order the settings area
// lists them. The command palette offers the same pages from this list.

import type { ReactNode } from "react";
import {
  Bell,
  Bot,
  Building2,
  FolderGit2,
  FolderKanban,
  Import,
  KeyRound,
  Plug,
  ScrollText,
  ShieldCheck,
  SquareAsterisk,
  UserRound,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import type { Key } from "@/lib/i18n";

export interface SettingsPage {
  /** Under the settings area: "me/profile". */
  path: string;
  label: Key;
  icon: ReactNode;
  /** More words a search for the page should find it by. */
  words?: string;
}

interface Listed extends SettingsPage {
  /** Only for workspace admins. */
  admin?: boolean;
}

const GROUPS: { title: Key; pages: Listed[] }[] = [
  {
    title: "settings.group.workspace",
    pages: [
      { path: "general", label: "settings.nav.general", icon: <Building2 />, admin: true, words: "workspace name" },
      { path: "members", label: "settings.nav.members", icon: <Users />, words: "people invite" },
      { path: "import", label: "settings.nav.import", icon: <Import />, admin: true, words: "github linear" },
      { path: "audit", label: "settings.nav.audit", icon: <ScrollText />, admin: true, words: "history" },
    ],
  },
  {
    title: "settings.group.work",
    pages: [
      { path: "projects", label: "settings.nav.projects", icon: <FolderKanban />, words: "statuses labels templates" },
    ],
  },
  {
    title: "settings.group.automation",
    pages: [
      { path: "agents", label: "settings.nav.agents", icon: <Bot />, words: "tokens" },
      { path: "webhooks", label: "settings.nav.webhooks", icon: <Webhook />, admin: true },
      { path: "rules", label: "settings.nav.rules", icon: <Workflow />, admin: true, words: "automation" },
      { path: "integrations", label: "settings.nav.integrations", icon: <Plug />, admin: true },
      {
        path: "secrets",
        label: "settings.nav.secrets",
        icon: <SquareAsterisk />,
        admin: true,
        words: "keys passwords",
      },
      { path: "sources", label: "settings.nav.sources", icon: <FolderGit2 />, admin: true, words: "git" },
    ],
  },
  {
    title: "settings.group.me",
    pages: [
      { path: "me/profile", label: "settings.nav.profile", icon: <UserRound />, words: "account name avatar" },
      {
        path: "me/security",
        label: "settings.nav.security",
        icon: <ShieldCheck />,
        words: "password passkey two-step",
      },
      { path: "me/notifications", label: "settings.nav.notifications", icon: <Bell />, words: "email push" },
      { path: "me/tokens", label: "settings.nav.tokens", icon: <KeyRound />, words: "api" },
    ],
  },
];

/** The settings pages someone may open, in groups: a member gets the ones that are not only for admins. */
export function settingsGroups(admin: boolean): { title: Key; pages: SettingsPage[] }[] {
  return GROUPS.map((group) => ({ title: group.title, pages: group.pages.filter((page) => admin || !page.admin) }));
}

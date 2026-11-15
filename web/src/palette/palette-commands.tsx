// The commands the palette offers: what can be done to the open task, what
// can be made, every place there is to go (each settings page included, so
// typing "status" or "label" finds where they are managed), and the few
// things about the app itself.

import type { ReactNode } from "react";
import {
  Bell,
  Bookmark,
  Bot,
  Building2,
  ChartGantt,
  CircleDot,
  Copy,
  FilePlus2,
  FileText,
  FolderGit2,
  FolderKanban,
  FolderPlus,
  Inbox,
  Kanban,
  Keyboard,
  KeyRound,
  Layers,
  LayoutDashboard,
  Link2,
  ListPlus,
  ListTodo,
  LogOut,
  MessageCircleQuestion,
  Monitor,
  Moon,
  Plug,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Shapes,
  ShieldCheck,
  SignalHigh,
  SlidersHorizontal,
  SquareAsterisk,
  Sun,
  SunMoon,
  Tag,
  Tags,
  Trash2,
  UserRound,
  Users,
  Webhook,
  Workflow,
  Wrench,
} from "lucide-react";
import { saveTheme, signOut } from "@/auth/session";
import { copyText } from "@/lib/files";
import { type Key, t } from "@/lib/i18n";
import { useMe, useProjects, useViews } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import type { Project, Task } from "@/lib/types";
import { ui } from "@/lib/ui-state";
import { openNewTask } from "@/tasks/draft";

export type ChoicePage = "status" | "assignee" | "priority" | "labels";
/** Pages where the box takes a name for something new. */
export type MakePage = "new-label" | "new-status";
export type PalettePage = ChoicePage | MakePage;

export interface Cmd {
  id: string;
  label: string;
  /** More words the search should match. */
  words?: string;
  icon: ReactNode;
  hint?: string;
  checked?: boolean;
  /** Listed only once something is typed: the palette opens on the short list. */
  deep?: boolean;
  run: () => void;
}

export interface CommandContext {
  slug: string;
  /** The task whose panel is open, if one is. */
  task: Task | undefined;
  /** The project in view: where a new task, label or status goes. */
  project: Project | undefined;
  /** Runs a command and closes the palette. */
  run: (action: () => void) => void;
  go: (path: string) => void;
  openPage: (page: PalettePage) => void;
}

const themeIcons: Record<ThemeChoice, ReactNode> = { system: <Monitor />, light: <Sun />, dark: <Moon /> };
const themes: ThemeChoice[] = ["system", "light", "dark"];

async function copy(text: string) {
  if (await copyText(text)) toast.info(t("common.copied"));
  else toast.error(t("common.copyFailed"));
}

/** The settings pages, as the settings area lists them. `admin` ones are for workspace admins. */
const SETTINGS: { path: string; label: Key; icon: ReactNode; admin?: boolean; words?: string }[] = [
  { path: "general", label: "settings.nav.general", icon: <Building2 />, admin: true, words: "workspace name" },
  { path: "members", label: "settings.nav.members", icon: <Users />, words: "people invite" },
  { path: "audit", label: "settings.nav.audit", icon: <ScrollText />, admin: true, words: "history" },
  { path: "projects", label: "settings.nav.projects", icon: <FolderKanban />, words: "statuses labels templates" },
  { path: "agents", label: "settings.nav.agents", icon: <Bot />, words: "tokens" },
  { path: "webhooks", label: "settings.nav.webhooks", icon: <Webhook />, admin: true },
  { path: "rules", label: "settings.nav.rules", icon: <Workflow />, admin: true, words: "automation" },
  { path: "integrations", label: "settings.nav.integrations", icon: <Plug />, admin: true },
  { path: "secrets", label: "settings.nav.secrets", icon: <SquareAsterisk />, admin: true, words: "keys passwords" },
  { path: "sources", label: "settings.nav.sources", icon: <FolderGit2 />, admin: true, words: "git" },
  { path: "me/profile", label: "settings.nav.profile", icon: <UserRound />, words: "account name avatar" },
  { path: "me/security", label: "settings.nav.security", icon: <ShieldCheck />, words: "password passkey two-step" },
  { path: "me/notifications", label: "settings.nav.notifications", icon: <Bell />, words: "email push" },
  { path: "me/tokens", label: "settings.nav.tokens", icon: <KeyRound />, words: "api" },
];

const PROJECT_TABS: { tab: "general" | "templates" | "preferences"; icon: ReactNode }[] = [
  { tab: "general", icon: <SlidersHorizontal /> },
  { tab: "templates", icon: <FileText /> },
  { tab: "preferences", icon: <Wrench /> },
];

export interface Commands {
  forTask: Cmd[];
  make: Cmd[];
  goTo: Cmd[];
  settings: Cmd[];
  general: Cmd[];
}

export function useCommands({ slug, task, project, run, go, openPage }: CommandContext): Commands {
  const projects = useProjects();
  const views = useViews();
  const me = useMe();
  const installAdmin = useStore((s) => !!s.user?.is_admin);
  const theme = useThemeChoice();
  const admin = me.role !== "member";
  const at = (path: string) => () => go(`/${slug}/${path}`);

  const forTask: Cmd[] = task
    ? [
        { id: "task:status", label: t("prop.set.status"), icon: <CircleDot />, hint: "S", run: () => openPage("status") },
        { id: "task:assignee", label: t("prop.set.assignee"), icon: <UserRound />, hint: "A", run: () => openPage("assignee") },
        { id: "task:priority", label: t("prop.set.priority"), icon: <SignalHigh />, hint: "P", run: () => openPage("priority") },
        { id: "task:labels", label: t("prop.set.labels"), icon: <Tag />, hint: "L", run: () => openPage("labels") },
        { id: "task:copy-key", label: t("palette.copyKey"), words: task.key, icon: <Copy />, run: () => run(() => void copy(task.key)) },
        {
          id: "task:copy-link",
          label: t("palette.copyLink"),
          words: "url",
          icon: <Link2 />,
          run: () => run(() => void copy(`${window.location.origin}/${slug}/task/${task.key}`)),
        },
      ]
    : [];

  const make: Cmd[] = [
    {
      id: "new:task",
      label: project ? t("palette.newTaskIn", { project: project.name }) : t("palette.newTask"),
      words: "new add create task",
      icon: <Plus />,
      hint: "C",
      run: () => openNewTask({ projectId: project?.id }),
    },
    {
      id: "new:tasks",
      label: t("palette.newTasks"),
      words: "new add create several many bulk list paste multiple",
      icon: <ListPlus />,
      run: () => openNewTask({ projectId: project?.id, many: true }),
    },
    {
      id: "new:page",
      label: t("palette.newPage"),
      words: "new add create doc document page",
      icon: <FilePlus2 />,
      // The pages' code is fetched when a page is first made or opened.
      run: () => run(() => void import("@/docs/actions").then((docs) => go(`/${slug}/docs/${docs.createDoc({})}`))),
    },
    ...(project
      ? [{ id: "new:label", label: t("palette.newLabel", { project: project.name }), words: "new add create label tag", icon: <Tag />, run: () => openPage("new-label") }]
      : []),
    ...(project && admin
      ? [
          {
            id: "new:status",
            label: t("palette.newStatus", { project: project.name }),
            words: "new add create status column",
            icon: <Shapes />,
            run: () => openPage("new-status"),
          },
        ]
      : []),
    ...(admin
      ? [{ id: "new:project", label: t("palette.newProject"), words: "new add create project", icon: <FolderPlus />, run: at("settings/projects?new=1") }]
      : []),
  ];

  const goTo: Cmd[] = [
    { id: "go:my-work", label: t("nav.myWork"), words: "home assigned", icon: <UserRound />, run: at("my-work") },
    { id: "go:inbox", label: t("nav.inbox"), words: "notifications", icon: <Inbox />, run: at("inbox") },
    ...projects.flatMap((p) => {
      const name = { project: p.name };
      const base = `p/${p.key}`;
      return [
        { id: `go:tasks:${p.id}`, label: t("palette.projectTasks", name), words: `${p.key} list`, icon: <ListTodo />, run: at(`${base}/tasks`) },
        { id: `go:board:${p.id}`, label: t("palette.projectBoard", name), words: `${p.key} kanban`, icon: <Kanban />, run: at(`${base}/board`) },
        { id: `go:timeline:${p.id}`, label: t("palette.projectTimeline", name), words: `${p.key} gantt roadmap`, icon: <ChartGantt />, run: at(`${base}/timeline`) },
        { id: `go:epics:${p.id}`, label: t("palette.projectEpics", name), words: p.key, icon: <Layers />, run: at(`${base}/epics`) },
        ...(p.settings?.cycles
          ? [{ id: `go:cycles:${p.id}`, label: t("palette.projectCycles", name), words: `${p.key} sprints`, icon: <RefreshCw />, run: at(`${base}/cycles`) }]
          : []),
      ];
    }),
    ...views.map((v) => ({ id: `go:view:${v.id}`, label: v.name, words: "view", icon: <Bookmark />, run: at(`view/${v.slug}`) })),
    { id: "go:docs", label: t("nav.docs"), words: "pages documents wiki", icon: <FileText />, run: at("docs") },
    { id: "go:dashboard", label: t("nav.dashboard"), words: "overview charts", icon: <LayoutDashboard />, run: at("dashboard") },
    { id: "go:agents", label: t("nav.agents"), words: "sessions", icon: <Bot />, run: at("agents") },
    { id: "go:decisions", label: t("nav.decisions"), words: "questions log", icon: <MessageCircleQuestion />, run: at("decisions") },
    { id: "go:trash", label: t("nav.trash"), words: "deleted", icon: <Trash2 />, run: at("trash") },
    { id: "go:settings", label: t("nav.settings"), words: "preferences", icon: <Settings />, run: at("settings") },
    ...(installAdmin ? [{ id: "go:admin", label: t("palette.admin"), words: "install server instance", icon: <Wrench />, run: () => go("/admin") }] : []),
  ];

  const settings: Cmd[] = [
    ...SETTINGS.filter((page) => admin || !page.admin).map((page) => ({
      id: `set:${page.path}`,
      label: t("palette.settingsPage", { page: t(page.label) }),
      words: page.words,
      icon: page.icon,
      deep: true,
      run: at(`settings/${page.path}`),
    })),
    ...projects.flatMap((p) => {
      const root = `settings/projects/${p.key}`;
      const name = { project: p.name };
      return [
        { id: `set:statuses:${p.id}`, label: t("palette.manageStatuses", name), words: `${p.key} settings columns workflow`, icon: <Shapes />, deep: true, run: at(`${root}/statuses`) },
        { id: `set:labels:${p.id}`, label: t("palette.manageLabels", name), words: `${p.key} settings tags`, icon: <Tags />, deep: true, run: at(`${root}/labels`) },
        ...PROJECT_TABS.map(({ tab, icon }) => ({
          id: `set:${tab}:${p.id}`,
          label: t("palette.projectSettings", { project: p.name, page: t(`project.tab.${tab}`) }),
          words: p.key,
          icon,
          deep: true,
          run: at(`${root}/${tab}`),
        })),
      ];
    }),
  ];

  // The theme in effect is on the page itself, whatever chose it.
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const general: Cmd[] = [
    { id: "shortcuts", label: t("top.shortcuts"), words: "keys help", icon: <Keyboard />, hint: "?", run: () => run(() => ui.setShortcuts(true)) },
    {
      id: "theme:toggle",
      label: dark ? t("palette.theme.toLight") : t("palette.theme.toDark"),
      words: "toggle switch theme appearance mode dark light",
      icon: <SunMoon />,
      run: () => run(() => void saveTheme(dark ? "light" : "dark")),
    },
    ...themes.map((choice) => ({
      id: `theme:${choice}`,
      label: t(`palette.theme.${choice}`),
      words: "appearance mode",
      icon: themeIcons[choice],
      checked: theme === choice,
      deep: true,
      run: () => run(() => void saveTheme(choice)),
    })),
    { id: "sign-out", label: t("top.signOut"), words: "log out logout", icon: <LogOut />, run: () => run(() => void signOut()) },
  ];

  return { forTask, make, goTo, settings, general };
}

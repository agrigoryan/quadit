// The commands the palette offers: what can be done to the open task, what
// can be made, every place there is to go (each settings page included, so
// typing "status" or "label" finds where they are managed), and the few
// things about the app itself.

import type { ReactNode } from "react";
import {
  Bookmark,
  Copy,
  FilePlus2,
  FileText,
  FolderPlus,
  Keyboard,
  Link2,
  ListPlus,
  Maximize2,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Shapes,
  SlidersHorizontal,
  Sun,
  SunMoon,
  Tag,
  Tags,
  Wrench,
} from "lucide-react";
import { matchPath, useLocation } from "react-router";
import { saveTheme, signOut } from "@/auth/session";
import { projectDocs, workspaceDocs } from "@/docs/area";
import { useCan } from "@/lib/access";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useProjects, useViews } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import type { Project, Task } from "@/types/core";
import { ui } from "@/lib/ui-state";
import { settingsGroups } from "@/settings/pages";
import { type Destination, DESTINATIONS, destinationPath, goKeys } from "@/shell/destinations";
import { openNewTask } from "@/tasks/draft";
import { PALETTE, type PropertyName } from "@/tasks/properties";
import { taskPath } from "@/lib/task-link";

/** Pages where the box takes a name for something new. */
export type MakePage = "new-label" | "new-status";
/** A page of a task property's values, by its name; or a page that makes something new. */
export type PalettePage = PropertyName | MakePage;

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
  /** The task that is open, in the panel or on its page, if one is. */
  task: Task | undefined;
  /** Turns the panel into the task's page; not given when the task is not in the panel. */
  expand?: () => void;
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

export function useCommands({ slug, task, expand, project, run, go, openPage }: CommandContext): Commands {
  const projects = useProjects();
  const views = useViews();
  const can = useCan();
  const installAdmin = useStore((s) => !!s.user?.is_admin);
  const theme = useThemeChoice();
  const admin = can.administer;
  const at = (path: string) => () => go(`/${slug}/${path}`);
  // On a project's Docs a new page is that project's; anywhere else it is tied to none.
  const docsOf = matchPath("/:ws/p/:key/docs/*", useLocation().pathname) ? project : undefined;
  const docsAt = docsOf ? projectDocs(slug, docsOf) : workspaceDocs(slug);

  const taskChanges: Cmd[] = PALETTE.map(({ name, picker, palette }) => ({
    id: `task:${name}`,
    label: picker.title(),
    icon: palette.icon,
    hint: picker.hotkey?.key.toUpperCase(),
    run: () => openPage(name),
  }));

  const forTask: Cmd[] = task
    ? [
        ...(expand
          ? [
              {
                id: "task:page",
                label: t("palette.openPage"),
                words: "full expand view",
                icon: <Maximize2 />,
                hint: "Enter",
                run: () => run(expand),
              },
            ]
          : []),
        // What changes the task: not for a task in the trash, nor for someone who may not edit it.
        ...(can.editTask(task) ? taskChanges : []),
        {
          id: "task:copy-key",
          label: t("palette.copyKey"),
          words: task.key,
          icon: <Copy />,
          run: () => run(() => void copy(task.key)),
        },
        {
          id: "task:copy-link",
          label: t("palette.copyLink"),
          words: "url",
          icon: <Link2 />,
          run: () => run(() => void copy(window.location.origin + taskPath(slug, task.key))),
        },
      ]
    : [];

  const newTasks: Cmd[] = [
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
  ];
  const newPage: Cmd = {
    id: "new:page",
    label: docsOf ? t("palette.newPageIn", { project: docsOf.name }) : t("palette.newPage"),
    words: "new add create doc document page",
    icon: <FilePlus2 />,
    // The pages' code is fetched when a page is first made or opened.
    run: () =>
      run(
        () =>
          void import("@/docs/actions").then((docs) => go(`${docsAt}/${docs.createDoc({ projectId: docsOf?.id })}`)),
      ),
  };

  // Each is offered only to someone who may make it where it would go.
  const make: Cmd[] = [
    ...(can.edit(project?.id) ? newTasks : []),
    ...(can.edit(docsOf?.id) ? [newPage] : []),
    ...(project && can.edit(project.id)
      ? [
          {
            id: "new:label",
            label: t("palette.newLabel", { project: project.name }),
            words: "new add create label tag",
            icon: <Tag />,
            run: () => openPage("new-label"),
          },
        ]
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
      ? [
          {
            id: "new:project",
            label: t("palette.newProject"),
            words: "new add create project",
            icon: <FolderPlus />,
            run: at("settings/projects?new=1"),
          },
        ]
      : []),
  ];

  // The places are one table (shell/destinations.tsx). A project's pages are listed for every project;
  // the letters after G go to those of the project in view, so only its rows carry the hint.
  const place = (d: Destination, of: Project | undefined): Cmd[] => {
    const path = destinationPath(d, { slug, project: of, installAdmin });
    if (!path) return [];
    const label = d.perProject && of ? t(d.perProject, { project: of.name }) : t(d.label);
    // "go" and "go to" find every place, as their heading says.
    const words = [t("palette.group.goto"), d.perProject && of ? of.key : "", d.words ?? ""].join(" ").trim();
    const hint = !d.perProject || of?.id === project?.id ? goKeys(d) : undefined;
    return [
      {
        id: of && d.perProject ? `go:${d.id}:${of.id}` : `go:${d.id}`,
        label,
        words,
        icon: d.icon,
        hint,
        run: () => go(path),
      },
    ];
  };
  const firstOfProject = DESTINATIONS.findIndex((d) => d.perProject);
  const lastOfProject = DESTINATIONS.findLastIndex((d) => d.perProject);
  const goTo: Cmd[] = [
    ...DESTINATIONS.slice(0, firstOfProject).flatMap((d) => place(d, undefined)),
    ...projects.flatMap((p) => DESTINATIONS.filter((d) => d.perProject).flatMap((d) => place(d, p))),
    ...views.map((v) => ({
      id: `go:view:${v.id}`,
      label: v.name,
      words: "view",
      icon: <Bookmark />,
      run: at(`view/${v.slug}`),
    })),
    ...DESTINATIONS.slice(lastOfProject + 1).flatMap((d) => place(d, undefined)),
  ];

  const settings: Cmd[] = [
    ...settingsGroups(admin)
      .flatMap((group) => group.pages)
      .map((page) => ({
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
        {
          id: `set:statuses:${p.id}`,
          label: t("palette.manageStatuses", name),
          words: `${p.key} settings columns workflow`,
          icon: <Shapes />,
          deep: true,
          run: at(`${root}/statuses`),
        },
        {
          id: `set:labels:${p.id}`,
          label: t("palette.manageLabels", name),
          words: `${p.key} settings tags`,
          icon: <Tags />,
          deep: true,
          run: at(`${root}/labels`),
        },
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
    {
      id: "shortcuts",
      label: t("top.shortcuts"),
      words: "keys help",
      icon: <Keyboard />,
      hint: "?",
      run: () => run(() => ui.setShortcuts(true)),
    },
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
    {
      id: "sign-out",
      label: t("top.signOut"),
      words: "log out logout",
      icon: <LogOut />,
      run: () => run(() => void signOut()),
    },
  ];

  return { forTask, make, goTo, settings, general };
}

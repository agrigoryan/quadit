import type { ReactNode } from "react";
import {
  Bookmark,
  CircleDot,
  Copy,
  FileText,
  Inbox,
  Kanban,
  Keyboard,
  Link2,
  ListTodo,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  SignalHigh,
  Sun,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import { saveTheme, signOut } from "@/auth/session";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useCollection, useProjects, useViews } from "@/lib/selectors";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import type { Project, SearchHit, Task } from "@/lib/types";
import { ui } from "@/lib/ui-state";
import { Group, Item, Note } from "@/palette/palette-parts";
import { matches, searchTasks, snippetParts } from "@/palette/palette-search";
import { DecisionMark, StatusIcon } from "@/ui/icons";

export type ChoicePage = "status" | "assignee" | "priority" | "labels";

interface Props {
  query: string;
  slug: string;
  /** The task whose panel is open, if one is. */
  task: Task | undefined;
  /** The project a new task goes to. */
  project: Project | undefined;
  hits: SearchHit[];
  searching: boolean;
  /** Runs a command and closes the palette. */
  run: (action: () => void) => void;
  go: (path: string) => void;
  openTask: (key: string) => void;
  openPage: (page: ChoicePage) => void;
}

interface Cmd {
  id: string;
  label: string;
  /** More words the search should match. */
  words?: string;
  icon: ReactNode;
  hint?: string;
  checked?: boolean;
  run: () => void;
}

const themeIcons: Record<ThemeChoice, ReactNode> = { system: <Monitor />, light: <Sun />, dark: <Moon /> };
const themes: ThemeChoice[] = ["system", "light", "dark"];

async function copy(text: string) {
  if (await copyText(text)) toast.info(t("common.copied"));
  else toast.error(t("common.copyFailed"));
}

/** The palette's first page: commands for the open task, places to go, tasks, and what the server found. */
export function RootPage({ query, slug, task, project, hits, searching, run, go, openTask, openPage }: Props) {
  const projects = useProjects();
  const views = useViews();
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const theme = useThemeChoice();
  const q = query.trim();
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

  const create: Cmd = {
    id: "create",
    label: project ? t("palette.newTaskIn", { project: project.name }) : t("palette.newTask"),
    words: "new add",
    icon: <Plus />,
    hint: "C",
    run: () => ui.newTask({ projectId: project?.id }),
  };

  const goTo: Cmd[] = [
    { id: "go:inbox", label: t("nav.inbox"), icon: <Inbox />, run: at("inbox") },
    { id: "go:my-work", label: t("nav.myWork"), icon: <UserRound />, run: at("my-work") },
    ...projects.flatMap((p) => [
      { id: `go:tasks:${p.id}`, label: t("palette.projectTasks", { project: p.name }), words: `${p.key} list`, icon: <ListTodo />, run: at(`p/${p.key}/tasks`) },
      { id: `go:board:${p.id}`, label: t("palette.projectBoard", { project: p.name }), words: `${p.key} kanban`, icon: <Kanban />, run: at(`p/${p.key}/board`) },
    ]),
    ...views.map((v) => ({ id: `go:view:${v.id}`, label: v.name, words: "view", icon: <Bookmark />, run: at(`view/${v.slug}`) })),
    { id: "go:trash", label: t("nav.trash"), words: "deleted", icon: <Trash2 />, run: at("trash") },
  ];

  const general: Cmd[] = [
    { id: "shortcuts", label: t("top.shortcuts"), words: "keys help", icon: <Keyboard />, hint: "?", run: () => run(() => ui.setShortcuts(true)) },
    ...themes.map((choice) => ({
      id: `theme:${choice}`,
      label: t(`palette.theme.${choice}`),
      words: "appearance mode",
      icon: themeIcons[choice],
      checked: theme === choice,
      run: () => run(() => void saveTheme(choice)),
    })),
    { id: "sign-out", label: t("top.signOut"), words: "log out", icon: <LogOut />, run: () => run(() => void signOut()) },
  ];

  const show = (cmds: Cmd[]) => (q ? cmds.filter((c) => matches(q, `${c.label} ${c.words ?? ""}`)) : cmds);
  const row = (c: Cmd) => (
    <Item key={c.id} value={c.id} icon={c.icon} hint={c.hint} checked={c.checked} onSelect={c.run}>
      {c.label}
    </Item>
  );

  const foundTasks = searchTasks(tasks, q);
  const listed = new Set(foundTasks.map((tk) => tk.key));
  // What the server found that is not already a row above; only things inside a task can be opened.
  const inText = hits.filter((h) => (h.task && !(h.kind === "task" && listed.has(h.task))) || h.scope_type === "doc").slice(0, 8);

  const taskRows = show(forTask);
  const goRows = show(goTo);
  const generalRows = show(q ? [create, ...general] : general);
  const nothing = taskRows.length + goRows.length + generalRows.length + foundTasks.length + inText.length === 0;

  if (nothing) return <Note>{searching ? t("palette.searching") : t("palette.empty", { q })}</Note>;

  return (
    <>
      <Group heading={task ? t("palette.group.task", { key: task.key }) : undefined}>{taskRows.map(row)}</Group>
      {!q && <Group>{row(create)}</Group>}
      <Group heading={t("palette.group.tasks")}>
        {foundTasks.map((tk) => (
          <Item
            key={tk.id}
            value={`open:${tk.id}`}
            icon={<StatusIcon category={statuses[tk.status_id]?.category ?? "backlog"} />}
            onSelect={() => openTask(tk.key)}
          >
            <span className="mr-2.5 text-xs text-ink-3 tnum">{tk.key}</span>
            {tk.title}
          </Item>
        ))}
      </Group>
      <Group heading={t("palette.group.goto")}>{goRows.map(row)}</Group>
      <Group heading={t("palette.group.general")}>{generalRows.map(row)}</Group>
      <Group heading={t("palette.group.found")}>
        {inText.map((hit) => (
          <HitRow key={`${hit.kind}:${hit.entity_id}`} hit={hit} onSelect={() => (hit.scope_type === "doc" ? go(`/${slug}/docs/${hit.scope_id}`) : openTask(hit.task as string))} />
        ))}
      </Group>
    </>
  );
}

/** Something the server found inside a task: where it is, and the words around the match. */
function HitRow({ hit, onSelect }: { hit: SearchHit; onSelect: () => void }) {
  const key = hit.task ?? "";
  const title = hit.title.startsWith(`${key} `) ? hit.title.slice(key.length + 1) : hit.title;
  const icon =
    hit.scope_type === "doc" ? <FileText /> : hit.kind === "decision" ? <DecisionMark mine={false} /> : hit.kind === "task" ? <ListTodo /> : <MessageSquare />;
  return (
    <Item
      value={`hit:${hit.kind}:${hit.entity_id}`}
      icon={icon}
      onSelect={onSelect}
      detail={hit.snippet ? snippetParts(hit.snippet).map((part, i) => (part.hit ? <b key={i} className="font-semibold text-ink-2">{part.text}</b> : part.text)) : undefined}
    >
      <span className="mr-2.5 text-xs text-ink-3 tnum">{key}</span>
      {title}
    </Item>
  );
}

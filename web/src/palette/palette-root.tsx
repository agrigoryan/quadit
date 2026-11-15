import { FileText, ListTodo, MessageSquare } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import { useRestLoaded, useStore } from "@/lib/store";
import type { SearchHit } from "@/lib/types";
import { type Cmd, type CommandContext, useCommands } from "@/palette/palette-commands";
import { Group, Item, Note } from "@/palette/palette-parts";
import { matches, searchTasks, snippetParts } from "@/palette/palette-search";
import { DecisionMark, StatusIcon } from "@/ui/icons";
import { ProjectGlyph } from "@/ui/project-glyph";

interface Props extends CommandContext {
  query: string;
  hits: SearchHit[];
  searching: boolean;
  openTask: (key: string) => void;
}

/**
 * The palette's first page. Commands come first (for the open task, to make
 * something, to go somewhere, about the app), and what the search found
 * comes under them: tasks by key and title, then words inside comments,
 * questions and pages.
 */
export function RootPage({ query, hits, searching, openTask, ...context }: Props) {
  const { slug, task, go } = context;
  const commands = useCommands(context);
  const tasks = useCollection("tasks");
  const statuses = useCollection("statuses");
  const restLoaded = useRestLoaded();
  const q = query.trim();

  const show = (cmds: Cmd[]) =>
    q ? cmds.filter((c) => matches(q, `${c.label} ${c.words ?? ""}`)) : cmds.filter((c) => !c.deep);
  const row = (c: Cmd) => (
    <Item key={c.id} value={c.id} icon={c.icon} hint={c.hint} checked={c.checked} onSelect={c.run}>
      {c.label}
    </Item>
  );

  const foundTasks = searchTasks(tasks, q);
  const listed = new Set(foundTasks.map((tk) => tk.key));
  // What the server found that is not already a row above; only things inside a task or a page can be opened.
  const inText = hits
    .filter((h) => (h.task && !(h.kind === "task" && listed.has(h.task))) || h.scope_type === "doc")
    .slice(0, 8);

  const taskRows = show(commands.forTask);
  const makeRows = show(commands.make);
  const goRows = show(commands.goTo);
  const settingsRows = show(commands.settings);
  const generalRows = show(commands.general);
  const nothing =
    taskRows.length +
      makeRows.length +
      goRows.length +
      settingsRows.length +
      generalRows.length +
      foundTasks.length +
      inText.length ===
    0;

  // Finished tasks arrive after the rest: until they have, "nothing matches" may only mean "not here yet".
  if (nothing)
    return (
      <Note>{searching ? t("palette.searching") : restLoaded ? t("palette.empty", { q }) : t("sync.loadingRest")}</Note>
    );

  return (
    <>
      <Group heading={task ? t("palette.group.task", { key: task.key }) : undefined}>{taskRows.map(row)}</Group>
      <Group heading={t("palette.group.make")}>{makeRows.map(row)}</Group>
      <Group heading={t("palette.group.goto")}>{goRows.map(row)}</Group>
      <Group heading={t("palette.group.settings")}>{settingsRows.map(row)}</Group>
      <Group heading={t("palette.group.general")}>{generalRows.map(row)}</Group>
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
      <Group heading={t("palette.group.found")}>
        {inText.map((hit) => (
          <HitRow
            key={`${hit.kind}:${hit.entity_id}`}
            hit={hit}
            onSelect={() =>
              hit.scope_type === "doc" ? go(`/${slug}/docs/${hit.scope_id}`) : openTask(hit.task as string)
            }
          />
        ))}
      </Group>
    </>
  );
}

/** Something the server found inside a task or a page: where it is (the task's key, the page's project), and the words around the match. */
function HitRow({ hit, onSelect }: { hit: SearchHit; onSelect: () => void }) {
  const project = useStore((s) =>
    hit.scope_type === "doc" && hit.project_id ? s.c.projects[hit.project_id] : undefined,
  );
  const key = hit.task ?? "";
  const title = hit.title.startsWith(`${key} `) ? hit.title.slice(key.length + 1) : hit.title;
  const icon =
    hit.scope_type === "doc" ? (
      <FileText />
    ) : hit.kind === "decision" ? (
      <DecisionMark mine={false} />
    ) : hit.kind === "task" ? (
      <ListTodo />
    ) : (
      <MessageSquare />
    );
  return (
    <Item
      value={`hit:${hit.kind}:${hit.entity_id}`}
      icon={icon}
      onSelect={onSelect}
      detail={
        hit.snippet
          ? snippetParts(hit.snippet).map((part, i) =>
              part.hit ? (
                <b key={i} className="font-semibold text-ink-2">
                  {part.text}
                </b>
              ) : (
                part.text
              ),
            )
          : undefined
      }
    >
      <span className="mr-2.5 text-xs text-ink-3 tnum">{key}</span>
      {project ? (
        // A page of a project carries the project's mark after its title, as it does in the page tree.
        <span className="inline-flex max-w-full items-center gap-1.5 align-bottom" title={project.name}>
          <span className="truncate">{title}</span>
          <ProjectGlyph project={project} />
        </span>
      ) : (
        title
      )}
    </Item>
  );
}

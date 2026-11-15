// Whose move it is when it is nobody's here: tasks that wait on something
// outside the workspace (a build, a reply, a date), and open tasks that name
// nobody at all. Read from the store, so both move as the feed does.

import { useMemo } from "react";
import { CircleHelp, Globe } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useCollection, useLiveTasks, useProjects, useSlug } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { isOpenCategory, type Task } from "@/lib/types";
import { Panel, PanelEmpty } from "@/insights/ui/panel";
import { ProjectGlyph } from "@/shell/sidebar";
import { useTaskLink } from "@/tasks/task-row";
import { Ago } from "@/ui/ago";

/** The next move is no member's but an outside event's; the note says which. */
type Waiting = Task & { waiting_outside?: boolean };

function useOpenTasks(projectId: string | undefined): Waiting[] {
  const tasks = useLiveTasks();
  const statuses = useCollection("statuses");
  return useMemo(
    () => tasks.filter((task) => (!projectId || task.project_id === projectId) && isOpenCategory(statuses[task.status_id]?.category)),
    [tasks, statuses, projectId],
  );
}

function OutsideRow({ task }: { task: Waiting }) {
  const link = useTaskLink(task);
  return (
    <li className="relative flex min-h-9 items-center gap-2 border-b border-line/70 px-4 py-1.5 text-sm hover:bg-hover">
      <Globe className="size-4 shrink-0 text-ink-3" aria-hidden />
      <div className="min-w-0 flex-1">
        <Link {...link} className="block truncate font-medium outline-none after:absolute after:inset-0 after:content-['']">
          {task.waiting_on_note || task.title}
        </Link>
        <p className="truncate text-xs text-ink-3">
          <span className="tnum">{task.key}</span> {task.waiting_on_note ? task.title : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(task.updated_at)}>
        <Ago ms={task.updated_at} />
      </span>
    </li>
  );
}

/** Tasks that wait on an outside event, the longest wait first. */
export function OutsidePanel({ projectId, className }: { projectId: string | undefined; className?: string }) {
  const open = useOpenTasks(projectId);
  const rows = useMemo(() => open.filter((task) => task.waiting_outside === true).sort((a, b) => a.updated_at - b.updated_at), [open]);
  return (
    <Panel
      title={t("dash.outside")}
      meta={rows.length > 0 ? <span className="text-xs text-ink-3 tnum">{rows.length}</span> : undefined}
      action={rows.length > 0 ? <span className="text-xs text-ink-3 max-sm:hidden">{t("dash.outside.hint")}</span> : undefined}
      className={className}
      flush
    >
      {rows.length === 0 ? (
        <PanelEmpty>{t("dash.outside.empty")}</PanelEmpty>
      ) : (
        <ul className="border-t border-line/70">
          {rows.map((task) => (
            <OutsideRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The list of a project's tasks that name nobody: its own filter. */
const nobodyPath = (slug: string, key: string) => `/${slug}/p/${key}/tasks?waiting_on=none&assignee=none`;

/** Open tasks with no assignee that wait on nobody and on nothing outside: work that will sit until someone picks it up. */
export function NobodyPanel({ projectId, className }: { projectId: string | undefined; className?: string }) {
  const slug = useSlug();
  const projects = useProjects();
  const open = useOpenTasks(projectId);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const task of open) {
      if (task.waiting_on_id || task.waiting_outside || task.assignee_id) continue;
      out.set(task.project_id, (out.get(task.project_id) ?? 0) + 1);
    }
    return out;
  }, [open]);
  const rows = projects.filter((p) => (counts.get(p.id) ?? 0) > 0);
  const total = rows.reduce((n, p) => n + (counts.get(p.id) ?? 0), 0);
  const only = rows.length === 1 ? rows[0] : undefined;
  return (
    <Panel title={t("dash.nobody")} className={className}>
      {total === 0 ? (
        <p className="py-1 text-sm text-ink-2">{t("dash.nobody.empty")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2 text-sm">
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-wait" aria-hidden />
            <span className="min-w-0">
              {only ? (
                <Link to={nobodyPath(slug, only.key)} className="font-medium text-accent-text underline-offset-2 hover:underline">
                  {t("dash.nobody.count", { n: total })}
                </Link>
              ) : (
                <span className="font-medium">{t("dash.nobody.count", { n: total })}</span>
              )}
              <span className="block text-xs text-ink-3">{t("dash.nobody.hint")}</span>
            </span>
          </p>
          {!only && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-sm">
              {rows.map((p) => (
                <li key={p.id}>
                  <Link to={nobodyPath(slug, p.key)} className="inline-flex items-center gap-1.5 text-accent-text underline-offset-2 hover:underline">
                    <ProjectGlyph project={p} />
                    {p.name}
                    <span className="text-ink-2 tnum">{counts.get(p.id)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

// What the desktop app's own windows (its menu-bar panel, quick capture,
// Connect) are told about the workspace this window shows: the questions
// waiting on me with a button per option, the agents and what each is
// doing, and the projects a task can be made in. The app holds it only
// while this window shows the workspace.

import { useEffect, useMemo, useRef } from "react";
import { can } from "@/data/access";
import { type AgentState, useAgentStates } from "@/data/listening";
import { useLookup, useMe, useOpenDecisions, useProjects, useSlug } from "@/data/selectors";
import { useStore } from "@/data/store";
import { t } from "@/lib/i18n";
import { taskPath } from "@/nav/task-link";
import { pickAction } from "@/shell/desktop-requests";
import type { DesktopSummary } from "@/types/desktop";

const WAITING_MAX = 20;
const ACTIONS_MAX = 6;
const AGENTS_MAX = 50;
const PROJECTS_MAX = 200;

/**
 * Keeps the desktop app told about this window's workspace, for as long as
 * the shell is on screen. Only in the app: it reads what the agents are
 * doing from the server, which a browser has no use for.
 */
export function useDesktopSummary() {
  const summary = useSummary();
  // Most edits to the copy change nothing the app is told: it is told again only when what it holds would change.
  const told = useRef("");

  useEffect(() => {
    const text = JSON.stringify(summary);
    if (!summary || text === told.current) return;
    told.current = text;
    window.quaditDesktop?.publish?.(summary);
  }, [summary]);

  // The shell going (signing out, say) takes the summary back; another workspace replaces it.
  useEffect(() => {
    const desktop = window.quaditDesktop;
    return () => desktop?.publish?.(null);
  }, []);
}

/** The summary of the open workspace, or null until its copy is loaded. */
export function useSummary(): DesktopSummary | null {
  const workspace = useStore((s) => s.workspace);
  const slug = useSlug();
  const me = useMe();
  const openDecisions = useOpenDecisions();
  const tasks = useLookup("tasks");
  const members = useLookup("members");
  const projects = useProjects();
  const states = useAgentStates().data;

  return useMemo(() => {
    if (!workspace) return null;
    const access = can(me);

    const asked = Object.values(openDecisions)
      .flat()
      .filter((d) => d.asked_id === me.user_id && tasks[d.task_id])
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, WAITING_MAX);
    const waiting = asked.map((decision) => {
      const task = tasks[decision.task_id];
      return {
        title: decision.question,
        detail: task ? `${task.key} ${task.title}` : "",
        path: task ? `${taskPath(slug, task.key)}#decision-${decision.id}` : `/${slug}`,
        actions: (decision.options ?? []).slice(0, ACTIONS_MAX).map((option) => pickAction(decision, option)),
      };
    });

    const agents = Object.values(states ?? {})
      .slice(0, AGENTS_MAX)
      .map((state) => {
        const member = members[state.user_id];
        return {
          id: state.user_id,
          // The member's handle: /agents says it with its "@", the app's pages and requests without.
          handle: member?.handle ?? state.handle.replace(/^@/, ""),
          name: member?.name ?? state.handle,
          state: state.state,
          detail: detailOf(state),
          path: state.state === "working" && state.task ? taskPath(slug, state.task) : `/${slug}/agents`,
          usable: access.administer || member?.responsible_id === me.user_id,
        };
      });

    return {
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      me: { name: me.name, canCreateAgents: access.administer },
      waiting,
      agents,
      projects: projects
        .filter((p) => access.edit(p.id))
        .slice(0, PROJECTS_MAX)
        .map((p) => ({ key: p.key, name: p.name })),
    };
  }, [workspace, slug, me, openDecisions, tasks, members, projects, states]);
}

/** One line of plain words for what an agent is doing, as the dashboard says it. */
function detailOf(agent: AgentState): string {
  switch (agent.state) {
    case "working":
      return [agent.task, agent.doing].filter(Boolean).join(" ");
    case "waiting":
      return t("dash.agents.waitsOn", { who: agent.waits_on ?? "" });
    case "has_work":
      return t("dash.agents.queue", { n: agent.waiting_on_it });
    case "idle":
      return agent.open_tasks > 0 ? t("dash.agents.open", { n: agent.open_tasks }) : t("dash.agents.nothing");
  }
}

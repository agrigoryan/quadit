// Agents at a glance: who is working on what, who waits on whom, who has
// work queued with nothing listening for it, and this week's spend.

import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useSlug, useTaskByKey } from "@/lib/selectors";
import { useMembersByHandle } from "@/insights/lib/members";
import type { AgentState } from "@/insights/lib/types";
import { AgentStateChip, BudgetBar, isStranded, NotListening } from "@/insights/ui/agent-bits";
import { Panel, PanelEmpty } from "@/insights/ui/panel";
import { useTaskLink } from "@/tasks/task-row";
import { Avatar } from "@/ui/avatar";

function TaskRef({ taskKey, title }: { taskKey: string; title?: string }) {
  const link = useTaskLink({ key: taskKey });
  const task = useTaskByKey(taskKey);
  return (
    <Link {...link} className="min-w-0 truncate text-ink-2 underline-offset-2 hover:text-ink hover:underline">
      <span className="tnum">{taskKey}</span> {title || task?.title}
    </Link>
  );
}

/** One line of plain words for what the agent is doing. */
function Doing({ agent }: { agent: AgentState }) {
  if (agent.state === "working") {
    return agent.task ? <TaskRef taskKey={agent.task} title={agent.doing} /> : <span className="truncate text-ink-2">{agent.doing}</span>;
  }
  if (agent.state === "waiting")
    return <span className="truncate text-ink-2">{t("dash.agents.waitsOn", { who: agent.waits_on ?? "" })}</span>;
  if (agent.state === "has_work") return <span className="truncate text-ink-2">{t("dash.agents.queue", { n: agent.waiting_on_it })}</span>;
  return (
    <span className="truncate text-ink-3">
      {agent.open_tasks > 0 ? t("dash.agents.open", { n: agent.open_tasks }) : t("dash.agents.nothing")}
    </span>
  );
}

function Row({ agent }: { agent: AgentState }) {
  const member = useMembersByHandle()(agent.handle);
  const stranded = isStranded(agent);
  return (
    <li className="border-b border-line/70 px-4 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Avatar member={member} size="md" />
        <span className="shrink-0 font-medium">{agent.name}</span>
        <AgentStateChip state={agent.state} />
        <span className="min-w-0 flex-1 truncate">
          <Doing agent={agent} />
        </span>
      </div>
      {(stranded || !agent.listening) && (
        <p className="mt-1.5 pl-8">
          <NotListening urgent={stranded} />
        </p>
      )}
      <BudgetBar agent={agent} className="mt-1.5 pl-8" />
    </li>
  );
}

export function AgentsPanel({ agents, className }: { agents: AgentState[]; className?: string }) {
  const slug = useSlug();
  const stranded = agents.filter(isStranded).length;
  return (
    <Panel
      title={t("nav.agents")}
      meta={
        stranded > 0 ? <span className="text-xs font-medium text-danger">{t("dash.agents.stranded", { n: stranded })}</span> : undefined
      }
      action={
        <Link to={`/${slug}/agents`} className="text-xs font-medium text-accent-text underline-offset-2 hover:underline">
          {t("dash.agents.all")}
        </Link>
      }
      className={className}
      flush
    >
      {agents.length === 0 ? (
        <PanelEmpty>{t("dash.agents.empty")}</PanelEmpty>
      ) : (
        <ul className="border-t border-line/70">
          {agents.map((agent) => (
            <Row key={agent.user_id} agent={agent} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

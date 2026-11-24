// The quiet line under the comment box of a task assigned to an agent or
// waiting on one: what will happen to what is written there. A comment
// reaches the inbox of the task's assignee and of whoever it waits on,
// followers or not (the server's rule), so the line's promise holds: an
// agent that is listening to the task's project will see it; one that
// listens only to other projects, or not at all, sees it when it is next
// asked, and is told the line that has it listen to this one; one that has
// never connected is offered the way to connect.

import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useConnection } from "@/data/listening";
import { useMember, useRowEvenIfGone } from "@/data/selectors";
import type { Member, Task } from "@/types/core";
import { useSettingsBase } from "@/settings/base";
import { canConnectTools, ConnectToolsButton } from "@/ui/connect-tools";

/** The line for the agent the task waits on, else the one it is assigned to; nothing for a person. */
export function CommentReach({ task }: { task: Task }) {
  const waitingOn = useMember(task.waiting_on_id);
  const assignee = useMember(task.assignee_id);
  const agent = [waitingOn, assignee].find((m) => m?.kind === "agent");
  // Only a task with an agent asks the server how far it is connected.
  return agent ? <AgentReach agent={agent} task={task} /> : null;
}

function AgentReach({ agent, task }: { agent: Member; task: Task }) {
  const reach = useConnection()(agent, task.project_id);
  // An archived project still has its key, as the task's header shows it.
  const project = useRowEvenIfGone("projects", task.project_id)?.key;
  const line = project ? t("comment.reach.line", { project }) : t("comment.reach.lineAny");
  const settings = useSettingsBase();
  if (!reach) return null;
  const { connection, tool, elsewhere } = reach;
  const handle = agent.handle;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-ink-3">
      {connection === "listening" && t("comment.reach.listening", { handle })}
      {connection === "connected" &&
        (elsewhere
          ? t("comment.reach.elsewhere", { handle, line })
          : tool
            ? t("comment.reach.connected", { handle, tool, line })
            : t("comment.reach.connectedNoTool", { handle, line }))}
      {connection === "not_connected" && (
        <>
          <span>{t("comment.reach.notConnected", { handle })}</span>
          {canConnectTools() ? (
            <ConnectToolsButton size="sm">{t("comment.reach.connect")}</ConnectToolsButton>
          ) : (
            <Link
              to={`${settings}/agents/${agent.handle}`}
              className="font-medium text-accent-text underline-offset-2 hover:underline"
            >
              {t("comment.reach.connectInSettings")}
            </Link>
          )}
        </>
      )}
    </p>
  );
}

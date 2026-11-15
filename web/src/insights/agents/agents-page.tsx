// The live view of agents: one card per agent, then the shared resources
// they take turns on. States, cost and reach come from the server (it alone
// knows what is listening and what was spent); everything else is read from
// the store, so the page moves as the feed does.

import { useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useCollection, useMe, useMembers, useSlug } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import type { AgentSession } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { useLive, useNow } from "@/insights/lib/live";
import type { AgentState } from "@/insights/lib/types";
import { isStranded } from "@/insights/ui/agent-bits";
import { PageBar } from "@/insights/ui/panel";
import { AgentCard, type HelperOf } from "@/insights/agents/agent-card";
import { NO_WORK, useAgentWork, useClaims, useResources } from "@/insights/agents/agent-data";
import { Resources } from "@/insights/agents/resources";
import { useSessions } from "@/insights/agents/session-data";
import type { AgentMember } from "@/settings/agents/data";
import { isFinishedHelper, placeHelpers, useHelperLabel } from "@/settings/agents/helpers";
import { Checkbox } from "@/settings/ui/form";
import { EmptyState } from "@/ui/empty";

const NO_SESSIONS: AgentSession[] = [];
const everySession = () => true;

/** Working first, then those with work queued, then waiting, then idle. */
const ORDER = { working: 0, has_work: 1, waiting: 2, idle: 3 } as const;

export function AgentsPage() {
  usePageTitle(t("nav.agents"));
  const slug = useSlug();
  const me = useMe();
  const members = useMembers();
  const now = useNow(15_000);
  const live = useLive<{ agents: AgentState[] }>("/agents");
  const { sessions } = useSessions("limit=300", everySession);
  const claims = useClaims();
  const resources = useResources();
  const work = useAgentWork(claims);

  const states = useMemo(() => {
    const out: Dict<AgentState> = {};
    for (const a of live.data?.agents ?? []) out[a.user_id] = a;
    return out;
  }, [live.data]);

  const agents = useMemo(
    () =>
      members
        .filter((m) => m.kind === "agent")
        .sort(
          (a, b) =>
            (ORDER[states[a.user_id]?.state ?? "idle"] ?? 3) - (ORDER[states[b.user_id]?.state ?? "idle"] ?? 3) ||
            a.name.localeCompare(b.name),
        ),
    [members, states],
  );

  const byAgent = useMemo(() => {
    const out: Dict<AgentSession[]> = {};
    for (const s of sessions) (out[s.agent_id] ??= []).push(s);
    return out;
  }, [sessions]);

  const resourceNames = useMemo(() => Object.fromEntries(resources.map((r) => [r.id, r.name])), [resources]);
  // A helper (an agent made for one task) is shown inside its maker's card; one whose task has closed is hidden until asked for.
  const [showFinished, setShowFinished] = useState(false);
  const tasks = useCollection("tasks");
  const helperLabel = useHelperLabel();
  const finished = agents.filter(isFinishedHelper).length;
  const active = agents.filter((a) => !isFinishedHelper(a));
  const cards = useMemo(() => {
    const out: { member: (typeof agents)[number]; helpers: HelperOf[] }[] = [];
    for (const { agent, depth } of placeHelpers(agents, showFinished).rows) {
      const top = out[out.length - 1];
      if (depth === 0 || !top) out.push({ member: agent, helpers: [] });
      else
        top.helpers.push({
          member: agent,
          state: states[agent.user_id],
          task: tasks[(agent as AgentMember).delegated_task ?? ""],
        });
    }
    return out;
  }, [agents, showFinished, states, tasks]);
  const working = active.filter((a) => states[a.user_id]?.state === "working").length;
  const stranded = active.filter((a) => {
    const s = states[a.user_id];
    return s && isStranded(s);
  }).length;

  return (
    <div className="flex h-full flex-col">
      <PageBar>
        <p className="flex-1 text-xs text-ink-2 tnum">
          {t("agents.count", { n: active.length })}
          {live.data && active.length > 0 && (
            <span className="text-ink-3">, {t("agents.workingCount", { n: working })}</span>
          )}
          {stranded > 0 && (
            <span className="ml-2 font-medium text-danger">{t("agents.strandedCount", { n: stranded })}</span>
          )}
        </p>
        {live.error && (
          <p role="alert" className="text-xs text-danger">
            {t("ins.loadFailed", { why: live.error })}
          </p>
        )}
        {finished > 0 && (
          <span className="pr-2">
            <Checkbox checked={showFinished} onChange={setShowFinished}>
              {t("agents.helper.showFinished", { n: finished })}
            </Checkbox>
          </span>
        )}
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas pb-10">
        {agents.length === 0 ? (
          <div className="border-b border-line bg-surface">
            <EmptyState
              icon={<Bot />}
              title={t("agents.empty")}
              hint={t(me.role === "member" ? "agents.emptyHintMember" : "agents.emptyHint")}
              action={
                me.role !== "member" && (
                  <Link
                    to={`/${slug}/settings/agents`}
                    className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
                  >
                    {t("agents.emptyAction")}
                  </Link>
                )
              }
            />
          </div>
        ) : (
          <div className="grid items-stretch md:grid-cols-2 2xl:grid-cols-3">
            {cards.map(({ member, helpers }) => (
              <AgentCard
                key={member.user_id}
                member={member}
                state={states[member.user_id]}
                helpers={helpers}
                helperNote={helperLabel(member)}
                work={work[member.user_id] ?? NO_WORK}
                sessions={byAgent[member.user_id] ?? NO_SESSIONS}
                resourceNames={resourceNames}
                now={now}
              />
            ))}
          </div>
        )}
        <div className="mt-4 border-y border-line">
          <Resources resources={resources} claims={claims} now={now} />
        </div>
      </div>
    </div>
  );
}

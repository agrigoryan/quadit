// The quiet line under a task's comment box when what is written there
// reaches an agent: what will happen to it. It follows the server's rule
// (agentsReached): a comment that mentions nobody reaches the task's
// assignee and whoever it waits on, followers or not; one that mentions
// members is, among agents, for those alone; whom it hands the task to is
// told either way. For one agent the line says it in full: an agent that
// is listening to the task's project will see it; one that listens only to
// other projects, or not at all, sees it when it is next asked, and is told
// the line that has it listen to this one; one that has never connected is
// offered the way to connect. An agent that a computer runs for the
// project is spoken of as the server foresees it instead (the run outlook):
// it starts now there, waits its turn, waits for the computer, is paused or
// will not start, and why. For several it says each one's state in a few
// words.

import { Link } from "react-router";
import { isKey, joinPhrases, t, tMaybe, type Key } from "@/lib/i18n";
import { exact, parseWhen } from "@/lib/time";
import { useConnection, type Connection } from "@/data/listening";
import { mayBeGivenWork } from "@/data/access";
import { useRunOutlook } from "@/data/run-outlook";
import { useMe, useMembers, useProjects, useRowEvenIfGone } from "@/data/selectors";
import { EMPTY_DRAFT, useDrafts, type Draft } from "@/detail/comment-actions";
import type { Member, Task } from "@/types/core";
import type { RunOutlook } from "@/types/dashboard";
import { useSettingsBase } from "@/settings/base";
import { canConnectTools, ConnectToolsButton } from "@/ui/connect-tools";

/** Members' handles as the server finds them in a comment (mentionRE in internal/engine/notify.go). */
const MENTION = /(^|[^A-Za-z0-9_@/])@([a-z0-9][a-z0-9_-]{1,31})/g;

/**
 * The agents the draft, sent by `me`, would reach, as the server works it
 * out (taskComment in internal/engine/ch_comments.go): those it mentions
 * and the one it hands the task to; when it mentions no member but its
 * writer, also the task's assignee and whoever it waits on. Each only where
 * it may read the task's project. An agent that follows the task by choice
 * hears it too, but a member is shown only their own follows, so it is left
 * out.
 */
function agentsReached(task: Task, draft: Draft, members: Member[], me: Member): Member[] {
  const handles = new Set(Array.from(draft.body.matchAll(MENTION), (m) => m[2]));
  const mentioned = members.filter((m) => handles.has(m.handle) && m.user_id !== me.user_id);
  const ids = mentioned.map((m) => m.user_id);
  if (draft.handTo) ids.push(draft.handTo);
  if (mentioned.length === 0) ids.push(task.waiting_on_id ?? "", task.assignee_id ?? "");
  const reached = new Set(ids);
  return members.filter(
    (m) =>
      reached.has(m.user_id) && m.kind === "agent" && m.user_id !== me.user_id && mayBeGivenWork(m, task.project_id),
  );
}

export function CommentReach({ task }: { task: Task }) {
  const draft = useDrafts((s) => s.drafts[task.id]) ?? EMPTY_DRAFT;
  const members = useMembers();
  const agents = agentsReached(task, draft, members, useMe());
  // Only a draft that reaches an agent asks the server how far it is connected.
  return agents.length > 0 ? <Reach agents={agents} members={members} task={task} /> : null;
}

/** The line for the agents a draft reaches: one in full, several in a few words each. */
function Reach({ agents, members, task }: { agents: Member[]; members: Member[]; task: Task }) {
  const connection = useConnection();
  // Only agents a computer runs are asked about: for the others the server would say none.
  const run = agents.filter((agent) => connection(agent, task.project_id)?.runner);
  const outlook = useRunOutlook(
    task.key,
    run.map((agent) => agent.handle),
    "comment",
  );
  // Until the server says what will happen, an agent a computer runs is not spoken of at all, rather than as listening.
  if (run.length > 0 && !outlook.outlooks && !outlook.error) return null;
  const runs = (agent: Member) => {
    const o = outlook.outlooks?.[`@${agent.handle}`];
    return o && o.outcome !== "none" && o.outcome !== "in_chat" ? o : undefined;
  };
  const [only, ...more] = agents;
  if (only && more.length === 0) {
    const o = runs(only);
    return o ? <RunReach outlook={o} members={members} task={task} /> : <AgentReach agent={only} task={task} />;
  }
  return (
    <AgentsReach
      agents={agents.filter((agent) => !runs(agent))}
      outlooks={agents.flatMap((agent) => runs(agent) ?? [])}
      members={members}
      task={task}
    />
  );
}

/** What an outlook's words name: the agent, its computer, program and folder, its owner by name, the project, a time. */
function wordsOf(o: RunOutlook, members: Member[]) {
  const owner = members.find((m) => `@${m.handle}` === o.owner);
  const when = parseWhen(o.outcome === "when_back" ? o.since : o.until);
  return {
    agent: o.agent,
    machine: o.machine,
    folder: o.folder,
    program: tMaybe(`run.program.${o.program}`, o.program),
    owner: owner?.name ?? o.owner,
    project: o.project,
    time: when ? exact(when) : "",
  };
}

/** The full line for one agent a computer runs, for a comment on the task `taskKey`. */
function runLine(o: RunOutlook, taskKey: string): Key {
  switch (o.outcome) {
    case "starts_now":
      return "comment.run.starts_now";
    case "queued":
      return o.running === taskKey ? "comment.run.queuedHere" : "comment.run.queued";
    case "when_back":
      return "comment.run.when_back";
    case "paused": {
      if (o.reason === "usage_limit" && !o.until) return "comment.run.paused.usage_limitUnknown";
      const key = `comment.run.paused.${o.reason}`;
      return isKey(key) ? key : "comment.run.paused.other";
    }
    default: {
      const key = `comment.run.will_not_start.${o.reason}`;
      return isKey(key) ? key : "comment.run.will_not_start.other";
    }
  }
}

/** The few words for one agent a computer runs, among several. */
function runPhrase(o: RunOutlook): Key {
  switch (o.outcome) {
    case "starts_now":
    case "queued":
    case "when_back":
    case "paused":
      return `comment.run.many.${o.outcome}`;
    default: {
      const key = `comment.run.many.${o.reason}`;
      return isKey(key) ? key : "comment.run.many.will_not_start";
    }
  }
}

/** For one agent a computer runs: what will happen to the comment, and, when nothing runs it here, the way to set it up. */
function RunReach({ outlook, members, task }: { outlook: RunOutlook; members: Member[]; task: Task }) {
  const words = wordsOf(outlook, members);
  const unset = outlook.outcome === "will_not_start" && outlook.reason === "no_runner_here";
  return (
    <p className={LINE}>
      <span>{t(runLine(outlook, task.key), words)}</span>
      {unset &&
        (canConnectTools() ? (
          <ConnectToolsButton size="sm">{t("comment.run.setUp")}</ConnectToolsButton>
        ) : (
          <span>{t("comment.run.setUpInApp", words)}</span>
        ))}
    </p>
  );
}

function AgentReach({ agent, task }: { agent: Member; task: Task }) {
  const reach = useConnection()(agent, task.project_id);
  // An archived project still has its key, as the task's header shows it.
  const project = useRowEvenIfGone("projects", task.project_id)?.key;
  // An agent of one project listens to everything when told plain “listen to Quadit” (the skill), so a project added
  // later is heard too: the line names the project only where the agent may work in several.
  const several =
    new Set([
      ...useProjects()
        .filter((p) => mayBeGivenWork(agent, p.id))
        .map((p) => p.id),
      task.project_id,
    ]).size > 1;
  const line = (key: string | undefined) =>
    key ? t("comment.reach.line", { project: key }) : t("comment.reach.lineAny");
  if (!reach) return null;
  const { connection, tool, elsewhere } = reach;
  const handle = agent.handle;
  return (
    <p className={LINE}>
      {connection === "listening" && t("comment.reach.listening", { handle })}
      {connection === "connected" &&
        (elsewhere
          ? t("comment.reach.elsewhere", { handle, line: line(project) })
          : tool
            ? t("comment.reach.connected", { handle, tool, line: line(several ? project : undefined) })
            : t("comment.reach.connectedNoTool", { handle, line: line(several ? project : undefined) }))}
      {connection === "not_connected" && (
        <>
          <span>{t("comment.reach.notConnected", { handle })}</span>
          <ConnectIt agents={[agent]} />
        </>
      )}
    </p>
  );
}

/**
 * The line for several agents: who will see it now, who when next asked,
 * who has not connected, and for each agent a computer runs, what will
 * happen there.
 */
function AgentsReach({
  agents,
  outlooks,
  members,
  task,
}: {
  agents: Member[];
  outlooks: RunOutlook[];
  members: Member[];
  task: Task;
}) {
  const connection = useConnection();
  const by: Record<Connection, Member[]> = { listening: [], connected: [], not_connected: [] };
  for (const agent of agents) {
    const reach = connection(agent, task.project_id);
    if (reach) by[reach.connection].push(agent);
  }
  const sentence = (key: Key, group: Member[]) =>
    group.length > 0 && (
      <span>{t(key, { n: group.length, handles: joinPhrases(group.map((m) => `@${m.handle}`)) })}</span>
    );
  if (outlooks.length === 0 && agents.every((agent) => !connection(agent, task.project_id))) return null;
  return (
    <p className={LINE}>
      {outlooks.map((o) => (
        <span key={o.agent}>{t(runPhrase(o), wordsOf(o, members))}</span>
      ))}
      {sentence("comment.reach.listeningMany", by.listening)}
      {sentence("comment.reach.notListeningMany", by.connected)}
      {sentence("comment.reach.notConnectedMany", by.not_connected)}
      {by.not_connected.length > 0 && <ConnectIt agents={by.not_connected} />}
    </p>
  );
}

const LINE = "mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-ink-3";

/** The way to connect agents: the app's Connect in the desktop app, else the agent's page in Settings (the agents', for several). */
function ConnectIt({ agents }: { agents: Member[] }) {
  const settings = useSettingsBase();
  const n = agents.length;
  if (canConnectTools()) return <ConnectToolsButton size="sm">{t("comment.reach.connect", { n })}</ConnectToolsButton>;
  const [only] = agents;
  return (
    <Link
      to={n === 1 && only ? `${settings}/agents/${only.handle}` : `${settings}/agents`}
      className="font-medium text-accent-text underline-offset-2 hover:underline"
    >
      {t("comment.reach.connectInSettings", { n })}
    </Link>
  );
}

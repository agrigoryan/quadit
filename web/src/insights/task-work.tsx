// What agents did on a task, shown in the task panel: their recorded
// sessions (who, when, what they did step by step, what it cost), and the
// branches, commits and pull requests the work lives in, each with its state
// and whether its checks pass.

import { useMemo } from "react";
import {
  CircleCheck,
  CircleX,
  Clock,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
} from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { send } from "@/lib/mutate";
import { useCollection } from "@/lib/selectors";
import type { AgentSession, Task, TaskLink } from "@/lib/types";
import { BranchCommits } from "@/detail/branch-commits";
import { linkName, useTaskLinks } from "@/detail/data";
import { Section } from "@/detail/section";
import { moneyMicros } from "@/insights/lib/format";
import { useNow } from "@/lib/live";
import { SessionRow } from "@/insights/agents/session-row";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/button";

type Tone = "neutral" | "accent" | "ok" | "danger" | "wait";

const kinds = { branch: GitBranch, commit: GitCommitHorizontal, pr: GitPullRequest } as const;
const states: Record<string, { icon: typeof GitMerge; tone: Tone }> = {
  open: { icon: GitPullRequest, tone: "accent" },
  draft: { icon: GitPullRequestDraft, tone: "neutral" },
  merged: { icon: GitMerge, tone: "ok" },
  closed: { icon: GitPullRequestClosed, tone: "neutral" },
};
const checks: Record<string, { icon: typeof GitMerge; tone: Tone }> = {
  passing: { icon: CircleCheck, tone: "ok" },
  failing: { icon: CircleX, tone: "danger" },
  pending: { icon: Clock, tone: "wait" },
};

/** The links the panel's own Links section keeps: plain web addresses. */
export const plainLinks = (links: TaskLink[]) => links.filter((l) => l.kind === "url");

const isWeb = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/** A state or a check result as an icon and a word; an unknown value is shown as it came. */
function Chip({
  value,
  known,
  prefix,
}: {
  value: string;
  known: typeof states;
  prefix: "taskwork.state." | "taskwork.checks.";
}) {
  const look = known[value];
  const Icon = look?.icon;
  return (
    <Badge tone={look?.tone ?? "neutral"}>
      {Icon && <Icon className="size-3" aria-hidden />}
      {tMaybe(prefix + value, value)}
    </Badge>
  );
}

function CodeLink({ link, readOnly }: { link: TaskLink; readOnly: boolean }) {
  const Icon = kinds[link.kind as keyof typeof kinds] ?? GitBranch;
  const name = linkName(link);
  const kind = tMaybe(`taskwork.kind.${link.kind}`, link.kind);
  const text = "min-w-0 flex-1 basis-40 truncate";
  return (
    <li className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line/70 py-1 text-sm last:border-b-0 max-md:min-h-10">
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-2" title={kind}>
        <Icon className="size-3.5" aria-hidden />
        <span className="sr-only">{kind}</span>
      </span>
      {isWeb(link.url) ? (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          title={link.url}
          className={`${text} underline-offset-2 hover:underline`}
        >
          {name}
        </a>
      ) : (
        <span className={text}>{name}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {link.title && link.kind === "pr" && link.ref && <span className="text-xs text-ink-3 tnum">#{link.ref}</span>}
        {link.state && <Chip value={link.state} known={states} prefix="taskwork.state." />}
        {link.checks && <Chip value={link.checks} known={checks} prefix="taskwork.checks." />}
        {!readOnly && (
          <IconButton
            label={t("taskwork.remove", { name })}
            size="sm"
            className="-mr-1 text-ink-3 max-md:size-8"
            onClick={() =>
              send({ type: "link.remove", args: { id: link.id } }, (tx) =>
                tx.patch("links", link.id, { deleted_at: Date.now() }),
              )
            }
          >
            <X className="size-3" />
          </IconButton>
        )}
      </span>
      <BranchCommits link={link} />
    </li>
  );
}

function Sessions({ sessions }: { sessions: AgentSession[] }) {
  // The clock only has to run while something is running.
  const running = sessions.some((s) => s.state === "running");
  const now = useNow(running ? 15_000 : 600_000);
  const cost = sessions.reduce((sum, s) => sum + (s.cost_micros ?? 0), 0);
  return (
    <Section
      title={t("taskwork.sessions")}
      meta={
        <span className="text-xs text-ink-3 tnum">
          {sessions.length}
          {cost > 0 && ` · ${t("taskwork.sessions.cost", { cost: moneyMicros(cost) })}`}
        </span>
      }
    >
      <ul>
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} now={now} showAgent />
        ))}
      </ul>
    </Section>
  );
}

/** Agent sessions and code links of a task. Draws nothing when the task has neither. */
export function TaskWork({ task }: { task: Task }) {
  const all = useCollection("sessions");
  const sessions = useMemo(
    () =>
      Object.values(all)
        .filter((s) => s.task_id === task.id)
        .sort((a, b) => b.started_at - a.started_at),
    [all, task.id],
  );
  const links = useTaskLinks(task.id);
  const code = useMemo(() => links.filter((l) => l.kind !== "url"), [links]);

  return (
    <>
      {code.length > 0 && (
        <Section title={t("taskwork.code")} meta={<span className="text-xs text-ink-3 tnum">{code.length}</span>}>
          <ul>
            {code.map((link) => (
              <CodeLink key={link.id} link={link} readOnly={!!task.deleted_at} />
            ))}
          </ul>
        </Section>
      )}
      {sessions.length > 0 && <Sessions sessions={sessions} />}
    </>
  );
}

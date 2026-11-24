// The top of an agent's card on the Agents page: whether it is connected,
// what hears it, and what can be done about it, a line each. It looks like
// the desktop app's own card for the agent (desktop/src/pages/tool-card.ts
// and run-by-quadit.ts) and says the same words for the same state; what
// each state means is said in the app's sheet of the agent, which the card
// opens. Only the app changes files on the computer, so what does that
// opens it on the agent.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { isKey, t, tMaybe } from "@/lib/i18n";
import { exact, parseWhen } from "@/lib/time";
import { useCan } from "@/data/access";
import { copyText } from "@/data/files";
import { useLookup } from "@/data/selectors";
import { toast } from "@/lib/toast";
import type { Member } from "@/types/core";
import type { AgentState, ListenerShown, RunnerShown } from "@/types/dashboard";
import { useSettingsBase } from "@/settings/base";
import { Button, buttonLook, IconButton } from "@/ui/button";
import { type LocalAgent, openConnect } from "@/ui/desktop-agents";

/** The program's title: from the connection reading, else from the app on this computer. */
const programOf = (state: AgentState | undefined, local: LocalAgent | undefined) =>
  state?.tool || local?.programName || "";

/** Whether it has proven it reaches Quadit: the big mark on the card's right, as on the app's card. */
export function ConnectionPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-ok-soft px-2 text-xs font-medium text-ok">
      <Check className="size-3.5" strokeWidth={2.4} aria-hidden />
      {t("agents.card.connected")}
    </span>
  ) : (
    <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-line px-2 text-xs text-ink-3">
      {t("agents.card.notConnected")}
    </span>
  );
}

/** A line of what hears the agent, with its dot, coloured by how it stands. */
function Line({
  tone,
  children,
  after,
}: {
  tone: "ok" | "work" | "wait" | "quiet";
  children: React.ReactNode;
  after?: React.ReactNode;
}) {
  const color = { ok: "text-ok", work: "text-accent-text", wait: "text-wait", quiet: "text-ink-3" }[tone];
  return (
    // What ends the line (a button, a link) goes under it when the card is too narrow for both.
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <p className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        <span className={cx("mt-1.5 size-2 shrink-0 rounded-full bg-current", color)} aria-hidden />
        <span className="min-w-0 flex-1 text-sm">{children}</span>
      </p>
      {after}
    </div>
  );
}

/** A Quadit runner's status, in the app's words: ready, working, a chat holds it for now, or paused and why. */
function runnerStatus(
  runner: RunnerShown,
  live: boolean,
  project: string,
  program: string,
): { text: string; tone: "ok" | "work" | "wait" } {
  if (live && !runner.holding) return { text: t("agents.card.aside", { project }), tone: "wait" };
  if (runner.paused) {
    const until = parseWhen(runner.paused_until);
    const key =
      runner.paused === "usage_limit" && !until
        ? "agents.card.paused.usage_limitUnknown"
        : `agents.card.paused.${runner.paused}`;
    const words = { program, machine: runner.machine, time: until ? exact(until) : "" };
    return { text: t(isKey(key) ? key : "agents.card.paused.other", words), tone: "wait" };
  }
  if (runner.task) return { text: t("agents.card.working", { task: runner.task }), tone: "work" };
  return { text: t("agents.card.ready"), tone: "ok" };
}

/**
 * What hears a connected agent, a line for each; with nothing hearing it,
 * the words that have it listen, with Copy. Where this computer can run it
 * and Quadit runs nothing for it yet, Run by Quadit ends the first line.
 * A project Quadit runs on this computer is said as the app says its own
 * entries, with Stop running (not while a run is in hand: Stop is on the
 * run).
 */
export function Hearing({
  member,
  state,
  local,
  busy,
}: {
  member: Member;
  state: AgentState;
  local: LocalAgent | undefined;
  busy: boolean;
}) {
  const projects = useLookup("projects");
  const program = programOf(state, local);
  const ownProjects = state.listeners.some((l) => l.project_id);
  const offer = local?.canRun && local.runs.length === 0 && (
    <Button
      size="sm"
      className="shrink-0 self-center"
      onClick={() => openConnect(member.user_id, "run", local.program)}
    >
      {t("agents.card.runByQuadit")}
    </Button>
  );
  const lines: React.ReactNode[] = [];
  for (const l of state.listeners) {
    if (l.runner) {
      lines.push(
        <RunnerLine
          key={`r${l.project_id}`}
          listener={l}
          runner={l.runner}
          local={local}
          program={program}
          busy={busy}
          member={member}
        />,
      );
      continue;
    }
    if (!l.live) continue;
    const what = l.project_id
      ? (projects[l.project_id]?.name ?? l.project ?? "")
      : t(ownProjects ? "agents.listener.everythingElse" : "agents.listener.everything");
    lines.push(
      <Line key={`l${l.project_id ?? ""}`} tone="ok" after={lines.length === 0 && offer}>
        <span className="font-medium">
          {l.by ? t("agents.listener.toFrom", { what, by: l.by }) : t("agents.listener.to", { what })}
        </span>
      </Line>,
    );
  }
  if (state.listening_outside_projects && !state.listeners.some((l) => !l.project_id && l.live))
    lines.push(
      <Line key="pushed" tone="ok" after={lines.length === 0 && offer}>
        <span className="font-medium">{t("agents.listener.webhook")}</span>
      </Line>,
    );
  if (lines.length === 0 && state.listening)
    lines.push(
      <Line key="any" tone="ok" after={offer}>
        <span className="font-medium">{t("agents.card.listening")}</span>
      </Line>,
    );
  if (lines.length === 0)
    lines.push(
      <Line key="not" tone="wait" after={offer}>
        <span className="text-ink">
          {t("agents.card.notListening")} <CopyListen />
        </span>
      </Line>,
    );
  return <div className="flex flex-col gap-1">{lines}</div>;
}

/**
 * A project Quadit's runner serves: on this computer as the app says its
 * entries ("Runs SVA in ~/devel/game. Ready.") with Stop running; on
 * another, that it runs it there; and, with its runner away, that its
 * requests wait.
 */
function RunnerLine({
  listener,
  runner,
  local,
  program,
  busy,
  member,
}: {
  listener: ListenerShown;
  runner: RunnerShown;
  local: LocalAgent | undefined;
  program: string;
  busy: boolean;
  member: Member;
}) {
  const project = listener.project ?? "";
  const title = program || tMaybe(`run.program.${runner.program}`, runner.program);
  if (!listener.live)
    return (
      <Line tone="quiet">
        <span className="text-ink-2">
          {t("agents.runner.away", { project, machine: runner.machine, time: exact(parseWhen(runner.since)) })}
        </span>
      </Line>
    );
  const here = !!listener.project_id && !!local?.runs.includes(listener.project_id);
  if (!here)
    return (
      <Line tone="ok">
        <span className="font-medium">{t("agents.card.runsElsewhere", { project, machine: runner.machine })}</span>
      </Line>
    );
  const status = runnerStatus(runner, listener.live, project, title);
  const color = { ok: "text-ok", work: "text-accent-text", wait: "text-wait" }[status.tone];
  return (
    <Line
      tone={status.tone}
      after={
        !busy && (
          <button
            type="button"
            onClick={() => openConnect(member.user_id, "run", local?.program)}
            aria-label={t("agents.card.stopRunningLabel", { project })}
            className="shrink-0 text-sm text-ink-3 underline underline-offset-2 hover:text-ink"
          >
            {t("agents.card.stopRunning")}
          </button>
        )
      }
    >
      <span className="font-medium text-ink">{t("agents.card.runs", { project, folder: runner.folder })}</span>{" "}
      <span className={color}>{status.text}</span>
    </Line>
  );
}

/** Copies the words that have it listen, and says so for a moment. */
function CopyListen() {
  const [done, setDone] = useState(false);
  async function copy() {
    if (!(await copyText(t("agents.card.listenWords")))) return toast.error(t("common.copyFailed"));
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <IconButton
      label={done ? t("common.copied") : t("agents.card.copyListen")}
      size="sm"
      className="-my-1 align-middle"
      onClick={() => void copy()}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

/**
 * Connecting an agent that has not proven it reaches Quadit, for whoever
 * may make it a connect code: in the app, its Connect window on the agent;
 * in a browser, the agent's page in Settings, where a connect code is made.
 */
export function ConnectIt({ member, app }: { member: Member; app: Record<string, LocalAgent> | null }) {
  const can = useCan();
  const settings = useSettingsBase();
  if (!can.agentTokens(member)) return null;
  return app ? (
    <Button variant="primary" size="sm" className="self-start" onClick={() => openConnect(member.user_id, "connect")}>
      {t("agents.card.connect")}
    </Button>
  ) : (
    <Link to={`${settings}/agents/${member.handle}`} className={cx(buttonLook("primary", "sm"), "self-start")}>
      {t("agents.card.connect")}
    </Link>
  );
}

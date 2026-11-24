// The top of an agent's card on the Agents page: whether it is connected,
// what hears it and what that means, and what can be done about it. It
// reads as the desktop app's own card for the agent (desktop/src/pages/
// tool-card.ts and run-by-quadit.ts) and says the same words for the same
// state, so the two are one thing in two places; the app's card alone
// changes files on the computer, so what does that opens it on the agent.

import { useState } from "react";
import { Check } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { isKey, t, tMaybe } from "@/lib/i18n";
import { exact, parseWhen } from "@/lib/time";
import { useCan } from "@/data/access";
import { copyText } from "@/data/files";
import { connectionOf } from "@/data/listening";
import { useLookup, useMe, useMember } from "@/data/selectors";
import { toast } from "@/lib/toast";
import type { Member } from "@/types/core";
import type { AgentState, ListenerShown, RunnerShown } from "@/types/dashboard";
import { useSettingsBase } from "@/settings/base";
import { Button, buttonLook } from "@/ui/button";
import { type LocalAgent, openConnect } from "@/ui/desktop-agents";

/** The program's title: from the connection reading, else from the app on this computer. */
const programOf = (state: AgentState | undefined, local: LocalAgent | undefined) =>
  state?.tool || local?.programName || "";

/** Whether it has proven it reaches Quadit: the big mark on the card's right, as on the app's card. */
export function ConnectionPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-ok-soft px-2.5 text-sm font-medium text-ok">
      <Check className="size-4" strokeWidth={2.4} aria-hidden />
      {t("agents.card.connected")}
    </span>
  ) : (
    <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-line px-2.5 text-sm text-ink-3">
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
    <p className="flex min-w-0 items-baseline gap-2">
      <span
        className={cx("size-2 shrink-0 translate-y-[-1px] self-center rounded-full bg-current", color)}
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-sm">{children}</span>
      {after}
    </p>
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
 * What hears a connected agent, a line for each, and under them one
 * sentence of what that means; with nothing hearing it, the next step,
 * set apart: the words to write in its chat, with Copy. A project Quadit
 * runs on this computer is said as the app says its own entries, with Stop
 * running (in the app, and not while a run is in hand: Stop is on the run).
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
  const lines: React.ReactNode[] = [];
  const by: string[] = [];
  for (const l of state.listeners) {
    const key = l.project ?? "";
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
      ? (projects[l.project_id]?.name ?? key)
      : t(ownProjects ? "agents.listener.everythingElse" : "agents.listener.everything");
    by.push(l.by ?? "");
    lines.push(
      <Line key={`l${l.project_id ?? ""}`} tone="ok">
        <span className="font-medium">
          {l.by ? t("agents.listener.toFrom", { what, by: l.by }) : t("agents.listener.to", { what })}
        </span>
      </Line>,
    );
  }
  const pushed = state.listening_outside_projects && !state.listeners.some((l) => !l.project_id && l.live);
  if (pushed)
    lines.push(
      <Line key="pushed" tone="ok">
        <span className="font-medium">{t("agents.listener.webhook")}</span>
      </Line>,
    );
  if (lines.length === 0 && state.listening)
    lines.push(
      <Line key="any" tone="ok">
        <span className="font-medium">{t("agents.card.listening")}</span>
      </Line>,
    );
  if (lines.length === 0) return <NextStep member={member} program={program} />;

  const chats = by.filter((b) => b === "a chat").length;
  const said =
    chats === 1
      ? t("agents.card.chatSaid")
      : chats > 1
        ? t("agents.card.chatsSaid")
        : by.includes("a companion")
          ? t("agents.card.companionSaid")
          : by.length > 0 || pushed
            ? t("agents.card.listeningSaid")
            : "";
  return (
    <div className="flex flex-col gap-1">
      {lines}
      {said && <p className="pl-4 text-sm text-ink-2">{said}</p>}
    </div>
  );
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
            onClick={() => openConnect(member.user_id, "run")}
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

/** Not listening yet: the next step, set apart, as the app's card sets it apart. */
function NextStep({ member, program }: { member: Member; program: string }) {
  const [done, setDone] = useState(false);
  const words = t("agents.card.listenWords");
  async function copy() {
    if (!(await copyText(words))) return toast.error(t("common.copyFailed"));
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <section
      aria-label={t("agents.card.nextStep", { name: member.name })}
      className="flex flex-col gap-2 rounded-lg border border-wait/40 bg-wait-soft/60 p-3"
    >
      <p className="text-sm font-medium text-ink">
        {program ? t("agents.card.notListening", { program }) : t("agents.card.notListeningNoProgram")}
      </p>
      <p className="flex items-center gap-2">
        <code className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-sm font-semibold text-ink">
          {words}
        </code>
        <Button size="sm" aria-label={t("agents.card.copyListen", { name: member.name })} onClick={() => void copy()}>
          {done ? t("common.copied") : t("s.copy")}
        </Button>
      </p>
    </section>
  );
}

/**
 * What can be done to have the agent work, below the line: connect it (in
 * the app, its Connect window; in a browser, its page in Settings, where a
 * connect code is made), or, where this computer can, have Quadit run it,
 * with the sentence the app says of it. Nothing when there is nothing to do.
 */
export function Offer({
  member,
  state,
  app,
}: {
  member: Member;
  state: AgentState | undefined;
  app: Record<string, LocalAgent> | null;
}) {
  const can = useCan();
  const me = useMe();
  const settings = useSettingsBase();
  const owner = useMember(member.responsible_id);
  const local = app?.[member.user_id];
  const connected = connectionOf(member, state) !== "not_connected";
  if (!connected) {
    if (!can.agentTokens(member)) return null;
    // In a browser a connect code is made on the agent's page in Settings.
    return app ? (
      <Button variant="primary" className="self-start" onClick={() => openConnect(member.user_id, "connect")}>
        {t("agents.card.connect")}
      </Button>
    ) : (
      <Link to={`${settings}/agents/${member.handle}`} className={cx(buttonLook("primary"), "self-start")}>
        {t("agents.card.connect")}
      </Link>
    );
  }
  if (!local?.canRun || local.runs.length > 0) return null;
  const program = programOf(state, local);
  const words = { program, handle: member.handle, owner: owner?.handle ?? "" };
  return (
    <div className="flex flex-col items-start gap-2 border-t border-line pt-3">
      <p className="text-sm text-ink-2">
        {owner && owner.user_id !== me.user_id ? t("agents.card.offerFor", words) : t("agents.card.offer", words)}
      </p>
      <Button onClick={() => openConnect(member.user_id, "run")}>{t("agents.card.runByQuadit")}</Button>
    </div>
  );
}

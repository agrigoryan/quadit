// What an agent listens to, one line for each live listener: "Listening to
// Samurai vs Aliens, from a chat", "Listening to everything else, from a
// companion"; "A webhook pushes to it" where a webhook is heard and nothing
// listens to everything. With `idle`, also a line for each project whose
// own listener is not live now: its items wait for it, and do not fall to
// what listens to everything. Nothing when nothing listens. A listener
// Quadit's runner marked says what runs the agent, where, and its state:
// "Runs Samurai vs Aliens on Aram's MacBook Pro, in ~/devel/game, with
// Claude Code. Ready"; that a chat holds it for now; or, with `idle`, that
// the computer is offline.

import { isKey, t, tMaybe } from "@/lib/i18n";
import { exact, parseWhen } from "@/lib/time";
import { useLookup } from "@/data/selectors";
import type { AgentState, RunnerShown } from "@/types/dashboard";

type Reading = Pick<AgentState, "listening" | "listeners" | "listening_projects" | "listening_outside_projects">;

/** The lines, each its own element, for the caller to lay out (a row of spans, a list). */
export function ListenerLines({ reading, idle, className }: { reading: Reading; idle?: boolean; className?: string }) {
  const projects = useLookup("projects");
  const ownProjects = reading.listeners.some((l) => l.project_id);
  const everything = reading.listeners.find((l) => !l.project_id && l.live);
  const lines: string[] = [];
  for (const l of reading.listeners) {
    const what = l.project_id
      ? (projects[l.project_id]?.name ?? l.project ?? "")
      : t(ownProjects ? "agents.listener.everythingElse" : "agents.listener.everything");
    if (l.runner && (l.live || idle)) lines.push(runnerLine(l.runner, what, l.live));
    else if (l.live)
      lines.push(l.by ? t("agents.listener.toFrom", { what, by: l.by }) : t("agents.listener.to", { what }));
  }
  // A webhook is heard for every item: it shows only as listening to what is in no project.
  if (!everything && reading.listening_outside_projects) lines.push(t("agents.listener.webhook"));
  // Listening to a project this viewer may not read: said without naming it.
  if (lines.length === 0 && reading.listening) lines.push(t("agents.connection.listening"));
  if (idle)
    for (const l of reading.listeners)
      // Its items wait only where nothing else hears them (a webhook does).
      if (l.project_id && !l.live && !l.runner && l.project && !reading.listening_projects.includes(l.project_id))
        lines.push(t("agents.listener.idle", { project: l.project }));
  return (
    <>
      {lines.map((line) => (
        <span key={line} className={className}>
          {line}
        </span>
      ))}
    </>
  );
}

/** A time the server wrote ("2026-11-24 14:02", UTC) as the person reads it. */
const at = (when: string | undefined) => {
  const ms = parseWhen(when);
  return ms ? exact(ms) : "";
};

/**
 * The line of a listener Quadit's runner marked, for the project named
 * `project`: a chat holds it for now; the runner is offline (its lease is
 * not live); or it runs the agent there, paused, working on a task, or
 * ready.
 */
function runnerLine(runner: RunnerShown, project: string, live: boolean): string {
  const words = {
    project,
    machine: runner.machine,
    folder: runner.folder,
    program: tMaybe(`run.program.${runner.program}`, runner.program),
    task: runner.task ?? "",
    time: at(runner.paused_until),
  };
  if (live && !runner.holding) return t("agents.runner.chat", words);
  if (!live) return t("agents.runner.away", { ...words, time: at(runner.since) });
  let status = t("agents.runner.ready");
  if (runner.paused) {
    const key =
      runner.paused === "usage_limit" && !runner.paused_until
        ? "agents.runner.paused.usage_limitUnknown"
        : `agents.runner.paused.${runner.paused}`;
    status = t(isKey(key) ? key : "agents.runner.paused.other", words);
  } else if (runner.task) status = t("agents.runner.working", words);
  return t("agents.runner.line", { runs: t("agents.runner.runs", words), status });
}

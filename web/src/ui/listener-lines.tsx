// What an agent listens to, one line for each live listener: "Listening to
// Samurai vs Aliens, from a chat", "Listening to everything else, from a
// companion"; "A webhook pushes to it" where a webhook is heard and nothing
// listens to everything. With `idle`, also a line for each project whose
// own listener is not live now: its items wait for it, and do not fall to
// what listens to everything. Nothing when nothing listens.

import { t } from "@/lib/i18n";
import { useLookup } from "@/data/selectors";
import type { AgentState } from "@/types/dashboard";

type Reading = Pick<AgentState, "listening" | "listeners" | "listening_projects" | "listening_outside_projects">;

/** The lines, each its own element, for the caller to lay out (a row of spans, a list). */
export function ListenerLines({ reading, idle, className }: { reading: Reading; idle?: boolean; className?: string }) {
  const projects = useLookup("projects");
  const ownProjects = reading.listeners.some((l) => l.project_id);
  const everything = reading.listeners.find((l) => !l.project_id && l.live);
  const lines: string[] = [];
  for (const l of reading.listeners) {
    if (!l.live) continue;
    const what = l.project_id
      ? (projects[l.project_id]?.name ?? l.project ?? "")
      : t(ownProjects ? "agents.listener.everythingElse" : "agents.listener.everything");
    lines.push(l.by ? t("agents.listener.toFrom", { what, by: l.by }) : t("agents.listener.to", { what }));
  }
  // A webhook is heard for every item: it shows only as listening to what is in no project.
  if (!everything && reading.listening_outside_projects) lines.push(t("agents.listener.webhook"));
  // Listening to a project this viewer may not read: said without naming it.
  if (lines.length === 0 && reading.listening) lines.push(t("agents.connection.listening"));
  if (idle)
    for (const l of reading.listeners)
      // Its items wait only where nothing else hears them (a webhook does).
      if (l.project_id && !l.live && l.project && !reading.listening_projects.includes(l.project_id))
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

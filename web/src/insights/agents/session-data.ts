// Agent sessions as these pages read them. The store has the sessions of
// the last days from the start, and the feed keeps each one whole: an update
// carries the steps and links it added, which the copy appends (data/apply.ts).
// Older sessions a page asks for
// are fetched once and put into the store, where the feed keeps them current
// like the rest. The key those fetches are cached under is here.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, workspacePath } from "@/data/api";
import { inWorkspace, readError } from "@/data/query";
import { getRow, useRows, useSlug } from "@/data/selectors";
import { getState, mergeRows } from "@/data/store";
import type { AgentSession } from "@/types/core";

/**
 * Sessions matching a /list/sessions query ("agent=ID", "task=KEY",
 * "limit=300"), newest first, kept current. `keep` picks the store rows
 * that belong to the same set; give the same function each render (one at
 * module level, or memoized), or the list is sorted afresh each time. When
 * the fetch fails, `error` says why: the sessions shown are then only the
 * recent ones the store had.
 */
export function useSessions(
  query: string | null,
  keep: (s: AgentSession) => boolean,
): { sessions: AgentSession[]; loading: boolean; error: string } {
  const slug = useSlug();
  // Asked again when the stream comes back: a copy fetched afresh after a long gap gets its older sessions back.
  const fetched = useQuery({
    queryKey: [...inWorkspace(slug), "sessions", query],
    queryFn: async ({ signal }) => {
      const out = await api.get<{ sessions: AgentSession[] }>(workspacePath(slug, `/list/sessions?${query}`), signal);
      // A session the store already has is newer there: the feed has been at it.
      if (getState().slug === slug)
        mergeRows(
          "sessions",
          out.sessions.filter((s) => !getRow("sessions", s.id)),
        );
      return true;
    },
    enabled: query !== null,
  });

  const stored = useRows("sessions");
  const sessions = useMemo(() => stored.filter(keep).sort((a, b) => b.started_at - a.started_at), [stored, keep]);
  return { sessions, loading: query !== null && fetched.isPending, error: readError(fetched.error) };
}

/**
 * One line of what a run did: the agent's own words on the way; a tool's
 * step with what it says (a description, a path); or tool steps in a row
 * that say nothing, of one kind, folded into one with their count.
 */
export type StepLine =
  | { kind: "words"; text: string }
  | { kind: "tool"; tool: string; text: string }
  | { kind: "fold"; tool: string; n: number };

export type ToolKind = "command" | "edit" | "webSearch";

/**
 * The tools a person knows by another word, by the names the programs give
 * them: Codex's and Claude Code's. A fold counts steps of one kind
 * together, so a shell step and a Bash step are both commands.
 */
const toolKinds: Record<string, ToolKind | undefined> = {
  shell: "command",
  Bash: "command",
  edit: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  "web search": "webSearch",
  WebSearch: "webSearch",
};

/** The kind of a tool a step names, when a person knows it by another word. */
export const toolKind = (tool: string): ToolKind | undefined => toolKinds[tool];

/**
 * What a run's recorded steps say, line by line. A step is an object
 * {tool, text} as a runner records it, a plain string, or any JSON a
 * session recorded by hand gave; a shape with neither a tool nor a string
 * to show is left out.
 */
export function stepLines(steps: readonly unknown[]): StepLine[] {
  const lines: StepLine[] = [];
  for (const step of steps) {
    const { text, tool } = readStep(step);
    const last = lines.at(-1);
    if (text) lines.push(tool ? { kind: "tool", tool, text } : { kind: "words", text });
    else if (!tool) continue;
    else if (last?.kind === "fold" && (toolKind(last.tool) ?? last.tool) === (toolKind(tool) ?? tool))
      lines[lines.length - 1] = { ...last, n: last.n + 1 };
    else lines.push({ kind: "fold", tool, n: 1 });
  }
  return lines;
}

/** What one recorded step says: its text, and the tool it used when it names one; empty when it says neither. */
function readStep(step: unknown): { text: string; tool: string } {
  if (typeof step === "string") return { text: step, tool: "" };
  if (!step || typeof step !== "object") return { text: "", tool: "" };
  const s = step as Record<string, unknown>;
  return { text: firstString(s.text, s.title, s.summary, s.action, s.name), tool: firstString(s.tool) };
}

const firstString = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v !== "") ?? "";

/** A link a run produced: an address with a name, a commit, a file. Nothing for a link that has no string to show. */
export function sessionLink(link: unknown): { name: string; url?: string } | null {
  if (typeof link === "string")
    return { name: link.replace(/^https?:\/\//, ""), url: /^https?:\/\//i.test(link) ? link : undefined };
  const l = (link && typeof link === "object" ? link : {}) as Record<string, unknown>;
  const url = typeof l.url === "string" && /^https?:\/\//i.test(l.url) ? l.url : undefined;
  const name = firstString(l.title, l.name, l.ref, l.url);
  return name ? { name, url } : null;
}

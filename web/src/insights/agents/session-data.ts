// Agent sessions as these pages read them. The store has the sessions of
// the last days from the start, and the feed keeps each one whole: an update
// carries the new list of steps and links. Older sessions a page asks for
// are fetched once and put into the store, where the feed keeps them current
// like the rest. The key those fetches are cached under is here.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, workspacePath } from "@/lib/api";
import { inWorkspace, readError } from "@/lib/query";
import { getRow, useRows, useSlug } from "@/lib/selectors";
import { getState, mergeRows } from "@/lib/store";
import type { AgentSession } from "@/lib/types";

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

/** What one recorded step says: its text, and the tool it used when it names one. */
export function stepText(step: unknown): { text: string; tool?: string } {
  if (typeof step === "string") return { text: step };
  if (step && typeof step === "object") {
    const s = step as Record<string, unknown>;
    const text = [s.text, s.title, s.summary, s.action, s.name].find((v) => typeof v === "string" && v) as
      string | undefined;
    const tool = typeof s.tool === "string" ? s.tool : undefined;
    return { text: text ?? JSON.stringify(step), tool };
  }
  return { text: String(step) };
}

/** A link a run produced: an address with a name, a commit, a file. */
export function sessionLink(link: unknown): { name: string; url?: string } {
  if (typeof link === "string")
    return { name: link.replace(/^https?:\/\//, ""), url: /^https?:\/\//i.test(link) ? link : undefined };
  const l = (link && typeof link === "object" ? link : {}) as Record<string, unknown>;
  const url = typeof l.url === "string" && /^https?:\/\//i.test(l.url) ? l.url : undefined;
  const name = [l.title, l.name, l.ref, l.url].find((v) => typeof v === "string" && v) as string | undefined;
  return { name: name ?? JSON.stringify(link), url };
}

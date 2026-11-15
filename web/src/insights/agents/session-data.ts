// Agent sessions as these pages read them. The store has the sessions of
// the last days from the start, and the feed keeps each one whole: an update
// carries the new list of steps and links. Older sessions a page asks for
// are fetched once and put into the store, where the feed keeps them current
// like the rest.

import { useEffect, useMemo, useState } from "react";
import { api, workspacePath } from "@/lib/api";
import { useCollection } from "@/lib/selectors";
import { getState, mergeRows, useStore } from "@/lib/store";
import type { AgentSession } from "@/lib/types";

/**
 * Sessions matching a /list/sessions query ("agent=ID", "task=KEY",
 * "limit=300"), newest first, kept current. `keep` picks the store rows
 * that belong to the same set.
 */
export function useSessions(
  query: string | null,
  keep: (s: AgentSession) => boolean,
): { sessions: AgentSession[]; loading: boolean } {
  const slug = useStore((s) => s.slug);
  const live = useStore((s) => s.stream === "live");
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (query === null) return;
    let current = true;
    api
      .get<{ sessions: AgentSession[] }>(workspacePath(slug, `/list/sessions?${query}`))
      .then((out) => {
        if (getState().slug !== slug) return;
        // A session the store already has is newer there: the feed has been at it.
        const have = getState().collections.sessions;
        mergeRows(
          "sessions",
          out.sessions.filter((s) => !have[s.id]),
        );
      })
      .catch(() => {})
      .finally(() => {
        if (current) setLoaded(query);
      });
    return () => {
      current = false;
    };
    // `live` is here so that a copy fetched afresh after a long gap gets its older sessions back.
  }, [slug, query, live]);

  const stored = useCollection("sessions");
  const sessions = useMemo(
    () =>
      Object.values(stored)
        .filter(keep)
        .sort((a, b) => b.started_at - a.started_at),
    // `keep` is a new function each render; what it selects by is in `query`.
    [stored, query],
  );
  return { sessions, loading: query !== null && loaded !== query };
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

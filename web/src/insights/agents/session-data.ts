// Agent sessions as these pages read them. The store keeps every session's
// state, cost and times current from the feed, but the feed says only which
// steps were added, not the whole list; so the full rows are fetched and
// fetched again when a session changes, and the store's live fields are laid
// over them so a card never lags behind.

import { useMemo } from "react";
import { useCollection } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import type { AgentSession } from "@/lib/types";
import { useLive } from "@/insights/lib/live";

const LIVE_FIELDS = ["state", "ended_at", "title", "summary", "cost_micros", "tokens_in", "tokens_out"] as const;

/** Fetched rows with the store's newer fields laid over, plus sessions only the store has yet. */
export function mergeSessions(fetched: AgentSession[], store: AgentSession[]): AgentSession[] {
  const live: Dict<AgentSession> = {};
  for (const s of store) live[s.id] = s;
  const seen = new Set<string>();
  const out = fetched.map((row) => {
    seen.add(row.id);
    const now = live[row.id];
    if (!now) return row;
    const merged: AgentSession = { ...row };
    for (const field of LIVE_FIELDS) {
      if (now[field] !== undefined) (merged as unknown as Record<string, unknown>)[field] = now[field];
    }
    return merged;
  });
  for (const s of store) if (!seen.has(s.id)) out.push(s);
  return out.sort((a, b) => b.started_at - a.started_at);
}

/**
 * Sessions matching a /list/sessions query ("agent=ID", "task=KEY",
 * "limit=300"), newest first, kept current. `keep` picks the store rows
 * that belong to the same set.
 */
export function useSessions(query: string | null, keep: (s: AgentSession) => boolean): { sessions: AgentSession[]; loading: boolean } {
  const live = useLive<{ sessions: AgentSession[] }>(query === null ? null : `/list/sessions?${query}`, { only: ["session"] });
  const stored = useCollection("sessions");
  const fetched = live.data?.sessions;
  const sessions = useMemo(
    () => mergeSessions(fetched ?? [], Object.values(stored).filter(keep)),
    // `keep` is a new function each render; what it selects by is in `query`.
    [fetched, stored, query],
  );
  return { sessions, loading: live.loading };
}

/** What one recorded step says: its text, and the tool it used when it names one. */
export function stepText(step: unknown): { text: string; tool?: string } {
  if (typeof step === "string") return { text: step };
  if (step && typeof step === "object") {
    const s = step as Record<string, unknown>;
    const text = [s.text, s.title, s.summary, s.action, s.name].find((v) => typeof v === "string" && v) as string | undefined;
    const tool = typeof s.tool === "string" ? s.tool : undefined;
    return { text: text ?? JSON.stringify(step), tool };
  }
  return { text: String(step) };
}

/** A link a run produced: an address with a name, a commit, a file. */
export function sessionLink(link: unknown): { name: string; url?: string } {
  if (typeof link === "string") return { name: link.replace(/^https?:\/\//, ""), url: /^https?:\/\//i.test(link) ? link : undefined };
  const l = (link && typeof link === "object" ? link : {}) as Record<string, unknown>;
  const url = typeof l.url === "string" && /^https?:\/\//i.test(l.url) ? l.url : undefined;
  const name = [l.title, l.name, l.ref, l.url].find((v) => typeof v === "string" && v) as string | undefined;
  return { name: name ?? JSON.stringify(link), url };
}

// Builds a task's timeline: its raw events become short lines, its comments
// become cards, all in time order. Changes one actor makes within a minute
// share a line.

import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/store";
import type { Attachment, Comment, Decision, FeedEvent, Relation, TaskLink } from "@/lib/types";
import {
  askedPhrase,
  type Changes,
  changePhrases,
  linkPhrase,
  pickedPhrase,
  relationPhrase,
  relationRemovedPhrase,
} from "@/detail/timeline-phrases";

export interface LineItem {
  kind: "line";
  id: string;
  at: number;
  actorId: string;
  phrases: string[];
  /** Words the actor wrote: shown under the line. */
  note?: string;
}

export interface CommentItem {
  kind: "comment";
  id: string;
  at: number;
  comment: Comment;
  replies: Comment[];
}

export type TimelineItem = LineItem | CommentItem;

const MERGE_WINDOW = 60_000;

/** A step on the way to an item: field changes are merged before they are put into words. */
type Atom =
  | { kind: "changes"; at: number; seq: number; actorId: string; changes: Changes; data: FeedEvent["data"] }
  | { kind: "line"; at: number; seq: number; actorId: string; phrases: string[]; note?: string; joins: boolean }
  | { kind: "comment"; at: number; seq: number; comment: Comment; replies: Comment[] };

const row = <T>(ev: FeedEvent) => ev.data.row as unknown as T | undefined;

function atomOf(ev: FeedEvent, taskId: string, events: FeedEvent[], withDecision: Set<string>): Atom | null {
  const base = { at: ev.at, seq: ev.seq, actorId: ev.actor_id };
  const line = (phrase: string | null, note?: string, joins = false): Atom | null =>
    phrase ? { kind: "line", ...base, phrases: [phrase], note: note || undefined, joins } : null;

  switch (ev.type) {
    case "task.created":
      return ev.entity_id === taskId ? line(t("timeline.created")) : null;
    case "task.updated":
    case "task.deleted": {
      if (ev.entity_id !== taskId || !ev.data.changes) return null;
      const changes = { ...ev.data.changes };
      // A question already says who it is asked of; do not say it twice.
      if (withDecision.has(ev.change_id)) {
        delete changes.waiting_on_id;
        delete changes.waiting_on_note;
      }
      return { kind: "changes", ...base, changes, data: ev.data };
    }
    case "decision.opened": {
      const d = row<Decision>(ev);
      return d ? line(askedPhrase(d)) : null;
    }
    case "decision.picked": {
      const d = row<Decision>(ev);
      return d ? line(pickedPhrase(d), d.outcome_note) : null;
    }
    case "decision.unclear": {
      const d = row<Decision>(ev);
      return d ? line(t("timeline.unclear", { question: d.question }), d.unclear_note) : null;
    }
    case "attachment.created": {
      const a = row<Attachment>(ev);
      if (!a || a.subject_type !== "task" || a.subject_id !== taskId) return null;
      return line(t("timeline.attached", { names: a.file?.name ?? "" }), undefined, true);
    }
    case "relation.created": {
      const r = row<Relation>(ev);
      return r ? line(relationPhrase(r, taskId), undefined, true) : null;
    }
    case "relation.deleted": {
      const made = events.find((e) => e.type === "relation.created" && e.entity_id === ev.entity_id);
      return line(relationRemovedPhrase(made ? row<Relation>(made) : undefined, taskId), undefined, true);
    }
    case "link.created": {
      const l = row<TaskLink>(ev);
      return l ? line(linkPhrase(l), undefined, true) : null;
    }
    default:
      return null;
  }
}

/** Later changes to a field replace earlier ones; a field put back as it was drops out. */
function mergeChanges(into: Changes, more: Changes): Changes {
  const out = { ...into };
  for (const [field, change] of Object.entries(more)) {
    const first = out[field];
    out[field] = first ? { from: first.from, to: change.to } : change;
    const merged = out[field];
    if (first && JSON.stringify(merged.from ?? null) === JSON.stringify(merged.to ?? null)) delete out[field];
  }
  return out;
}

/** The task's own comments as threads: each top-level comment with its replies, oldest first. */
function threads(taskId: string, comments: Dict<Comment>): { comment: Comment; replies: Comment[] }[] {
  const mine = Object.values(comments)
    .filter((c) => c.task_id === taskId && c.subject_type === "task" && !c.deleted_at)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const live = new Set(mine.map((c) => c.id));
  const replies: Dict<Comment[]> = {};
  const tops: Comment[] = [];
  for (const c of mine) {
    // A reply whose parent was deleted stands on its own.
    if (c.parent_id && live.has(c.parent_id)) (replies[c.parent_id] ??= []).push(c);
    else tops.push(c);
  }
  return tops.map((comment) => ({ comment, replies: replies[comment.id] ?? [] }));
}

export function buildTimeline(taskId: string, events: FeedEvent[], comments: Dict<Comment>): TimelineItem[] {
  const withDecision = new Set(events.filter((ev) => ev.type.startsWith("decision.")).map((ev) => ev.change_id));
  const commentSeq: Dict<number> = {};
  const atoms: Atom[] = [];
  for (const ev of events) {
    if (ev.type === "comment.created") commentSeq[ev.entity_id] = ev.seq;
    const atom = atomOf(ev, taskId, events, withDecision);
    if (atom) atoms.push(atom);
  }
  // A comment just written has no place in the feed yet: it goes last, where it will stay.
  for (const thread of threads(taskId, comments)) {
    const stored = (thread.comment as Comment & { created_seq?: number }).created_seq;
    const seq = commentSeq[thread.comment.id] ?? stored ?? Number.MAX_SAFE_INTEGER;
    atoms.push({ kind: "comment", at: thread.comment.created_at, seq, ...thread });
  }
  atoms.sort((a, b) => a.seq - b.seq || a.at - b.at);

  // First fold runs of field changes together, then put them into words.
  const folded: Atom[] = [];
  for (const atom of atoms) {
    const prev = folded[folded.length - 1];
    if (atom.kind === "changes" && prev?.kind === "changes" && prev.actorId === atom.actorId && atom.at - prev.at < MERGE_WINDOW) {
      folded[folded.length - 1] = { ...prev, changes: mergeChanges(prev.changes, atom.changes), data: { ...prev.data, ...atom.data } };
    } else {
      folded.push(atom);
    }
  }

  const items: TimelineItem[] = [];
  /** Ids of the lines that later phrases may join. */
  const joinable = new Set<string>();
  for (const atom of folded) {
    if (atom.kind === "comment") {
      items.push({ kind: "comment", id: atom.comment.id, at: atom.at, comment: atom.comment, replies: atom.replies });
      continue;
    }
    const phrases = atom.kind === "changes" ? changePhrases(atom.changes, atom.actorId, atom.data) : atom.phrases;
    if (phrases.length === 0) continue;
    const joins = atom.kind === "changes" || atom.joins;
    const prev = items[items.length - 1];
    if (joins && prev?.kind === "line" && joinable.has(prev.id) && prev.actorId === atom.actorId && atom.at - prev.at < MERGE_WINDOW) {
      prev.phrases.push(...phrases);
      continue;
    }
    const id = `ev-${atom.seq}`;
    if (joins) joinable.add(id);
    items.push({ kind: "line", id, at: atom.at, actorId: atom.actorId, phrases: [...phrases], note: atom.kind === "line" ? atom.note : undefined });
  }
  return items;
}

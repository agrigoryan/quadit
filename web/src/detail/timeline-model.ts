// Builds a task's timeline: its raw events become short lines, its comments
// become cards, all in time order. Changes one actor makes within a minute
// share a line. Things taken away (a comment deleted, a file or link
// removed) are quiet lines, so the record has no holes.

import { t } from "@/lib/i18n";
import type { Dict } from "@/data/store";
import type { Attachment, Comment, Decision, FeedEvent, Relation, TaskLink } from "@/types/core";
import { type Known, knownRows, type StoredRows } from "@/detail/timeline-known";
import {
  askedPhrase,
  changePhrases,
  commentDeletedPhrase,
  fileRemovedPhrase,
  type FilePlace,
  filesPhrase,
  linkPhrase,
  linkRemovedPhrase,
  pickedPhrase,
  relatedPhrase,
  relationPhrase,
  relationRemovedPhrase,
} from "@/detail/timeline-phrases";
import type { Changes } from "@/tasks/properties/property";

export interface LineItem {
  kind: "line";
  id: string;
  at: number;
  actorId: string;
  phrases: string[];
  /** Words the actor wrote: shown under the line. */
  note?: string;
  /** Something was taken away: drawn fainter than the rest. */
  quiet?: boolean;
}

interface CommentItem {
  kind: "comment";
  id: string;
  at: number;
  comment: Comment;
  replies: Comment[];
}

export type TimelineItem = LineItem | CommentItem;

const MERGE_WINDOW = 60_000;

interface Base {
  at: number;
  seq: number;
  actorId: string;
}

/** A step on the way to an item: field changes and files are merged before they are put into words. */
type Atom =
  | (Base & { kind: "changes"; changes: Changes; data: FeedEvent["data"] })
  | (Base & { kind: "line"; phrases: string[]; note?: string; joins: boolean; quiet?: boolean })
  | (Base & { kind: "files"; place: FilePlace; names: string[] })
  | { kind: "comment"; at: number; seq: number; comment: Comment; replies: Comment[] };

const row = <T>(ev: FeedEvent) => ev.data.row as T | undefined;

/** Where a file was put, if that is something the timeline says: on the task, a question or one of its options. */
function placeOf(a: Attachment, taskId: string, known: Known): FilePlace | null {
  if (a.subject_type === "task") return a.subject_id === taskId ? { on: "task", id: taskId, name: "" } : null;
  if (a.subject_type === "decision_option")
    return { on: "option", id: a.subject_id, name: known.options[a.subject_id] ?? "" };
  if (a.subject_type === "decision")
    return { on: "decision", id: a.subject_id, name: known.questions[a.subject_id] ?? "" };
  // A comment's files are drawn with the comment.
  return null;
}

/** How long after a question is asked its asker's files still count as part of asking it. */
const WITH_THE_QUESTION_MS = 60_000;

/**
 * True for a file the asker put on a question or an option while asking. The
 * question's card shows those, so the timeline does not repeat them; a file
 * added later, or by someone else, is news and gets its line.
 */
function cameWithTheQuestion(ev: FeedEvent, place: FilePlace, known: Known): boolean {
  if (place.on === "task") return false;
  const asked = known.asked[place.id];
  return !!asked && asked.by === ev.actor_id && ev.at >= asked.at && ev.at - asked.at < WITH_THE_QUESTION_MS;
}

function atomsOf(ev: FeedEvent, taskId: string, known: Known, withDecision: Set<string>): Atom[] {
  const base: Base = { at: ev.at, seq: ev.seq, actorId: ev.actor_id };
  const line = (phrase: string | null, opts: { note?: string; joins?: boolean; quiet?: boolean } = {}): Atom[] =>
    phrase
      ? [
          {
            kind: "line",
            ...base,
            phrases: [phrase],
            note: opts.note || undefined,
            joins: opts.joins ?? false,
            quiet: opts.quiet,
          },
        ]
      : [];
  const files = (list: Attachment[]): Atom[] =>
    list.flatMap((a): Atom[] => {
      const place = placeOf(a, taskId, known);
      if (!place || cameWithTheQuestion(ev, place, known)) return [];
      return [{ kind: "files", ...base, place, names: [a.file?.name ?? t("timeline.aFile")] }];
    });

  switch (ev.type) {
    case "task.created":
      return ev.entity_id === taskId ? line(t("timeline.created")) : [];
    case "task.updated":
    case "task.deleted": {
      if (ev.entity_id !== taskId || !ev.data.changes) return [];
      const changes = { ...ev.data.changes };
      // A question already says who it is asked of; do not say it twice.
      if (withDecision.has(ev.change_id)) {
        delete changes.waiting_on_id;
        delete changes.waiting_on_note;
      }
      return [{ kind: "changes", ...base, changes, data: ev.data }];
    }
    case "task.related":
      // The relation's own event belongs to the task at the other end; this one is ours.
      return ev.entity_id === taskId
        ? line(relatedPhrase(ev.data), { joins: true, quiet: ev.data.removed === true })
        : [];
    case "decision.opened": {
      const d = row<Decision>(ev);
      // Files sent with the question come inside its event.
      return d ? [...line(askedPhrase(d)), ...files(ev.data.attachments ?? [])] : [];
    }
    case "decision.picked": {
      const d = row<Decision>(ev);
      return d ? line(pickedPhrase(d), { note: d.outcome_note }) : [];
    }
    case "decision.unclear": {
      const d = row<Decision>(ev);
      return d ? line(t("timeline.unclear", { question: d.question }), { note: d.unclear_note }) : [];
    }
    case "decision.deleted": {
      const question = known.questions[ev.entity_id];
      return line(question ? t("timeline.questionDeleted", { question }) : t("timeline.questionDeletedAny"), {
        quiet: true,
      });
    }
    case "attachment.created": {
      const a = row<Attachment>(ev);
      return a ? files([a]) : [];
    }
    case "attachment.deleted": {
      const a = known.attachments[ev.entity_id];
      // A file that went with its comment is not told apart from the comment.
      if (a?.subject_type === "comment" && known.comments[a.subject_id]?.deleted_at) return [];
      return line(fileRemovedPhrase(a, a ? placeOf(a, taskId, known) : null), { joins: true, quiet: true });
    }
    case "comment.deleted":
      return line(commentDeletedPhrase(known.comments[ev.entity_id], ev.actor_id), { quiet: true });
    case "relation.created": {
      const r = row<Relation>(ev);
      return r ? line(relationPhrase(r, taskId), { joins: true }) : [];
    }
    case "relation.deleted":
      return line(relationRemovedPhrase(known.relations[ev.entity_id], taskId), { joins: true, quiet: true });
    case "link.created": {
      const l = row<TaskLink>(ev);
      return l ? line(linkPhrase(l), { joins: true }) : [];
    }
    case "link.deleted":
      return line(linkRemovedPhrase(known.links[ev.entity_id]), { joins: true, quiet: true });
    default:
      return [];
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

/** The task's own comments as threads: each top-level comment with its replies, oldest first. `comments` holds live ones only. */
function threads(taskId: string, comments: Dict<Comment>): { comment: Comment; replies: Comment[] }[] {
  const mine = Object.values(comments)
    .filter((c) => c.task_id === taskId && c.subject_type === "task")
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

/** Folds runs together: field changes into one set, files put in the same place into one list. */
function fold(atoms: Atom[]): Atom[] {
  const out: Atom[] = [];
  for (const atom of atoms) {
    const prev = out[out.length - 1];
    const near =
      prev &&
      prev.kind !== "comment" &&
      atom.kind !== "comment" &&
      prev.actorId === atom.actorId &&
      atom.at - prev.at < MERGE_WINDOW;
    if (near && atom.kind === "changes" && prev.kind === "changes") {
      out[out.length - 1] = {
        ...prev,
        changes: mergeChanges(prev.changes, atom.changes),
        data: { ...prev.data, ...atom.data },
      };
    } else if (
      near &&
      atom.kind === "files" &&
      prev.kind === "files" &&
      prev.place.on === atom.place.on &&
      prev.place.id === atom.place.id
    ) {
      out[out.length - 1] = { ...prev, names: [...prev.names, ...atom.names] };
    } else {
      out.push(atom);
    }
  }
  return out;
}

/** `comments`: the live comments, drawn as cards; `stored`: every row, to name what is gone. */
export function buildTimeline(
  taskId: string,
  events: FeedEvent[],
  comments: Dict<Comment>,
  stored: StoredRows,
): TimelineItem[] {
  const withDecision = new Set(events.filter((ev) => ev.type.startsWith("decision.")).map((ev) => ev.change_id));
  const known = knownRows(events, stored);
  const commentSeq: Dict<number> = {};
  const atoms: Atom[] = [];
  for (const ev of events) {
    if (ev.type === "comment.created") commentSeq[ev.entity_id] = ev.seq;
    atoms.push(...atomsOf(ev, taskId, known, withDecision));
  }
  // A comment just written has no place in the feed yet: it goes last, where it will stay.
  for (const thread of threads(taskId, comments)) {
    const stored = (thread.comment as Comment & { created_seq?: number }).created_seq;
    const seq = commentSeq[thread.comment.id] ?? stored ?? Number.MAX_SAFE_INTEGER;
    atoms.push({ kind: "comment", at: thread.comment.created_at, seq, ...thread });
  }
  atoms.sort((a, b) => a.seq - b.seq || a.at - b.at);

  const items: TimelineItem[] = [];
  /** Ids of the lines that later phrases may join. */
  const joinable = new Set<string>();
  for (const atom of fold(atoms)) {
    if (atom.kind === "comment") {
      items.push({ kind: "comment", id: atom.comment.id, at: atom.at, comment: atom.comment, replies: atom.replies });
      continue;
    }
    const phrases =
      atom.kind === "changes"
        ? changePhrases(atom.changes, atom.actorId, atom.data)
        : atom.kind === "files"
          ? [filesPhrase(atom.place, atom.names)]
          : atom.phrases;
    if (phrases.length === 0) continue;
    const joins = atom.kind !== "line" || atom.joins;
    const quiet = atom.kind === "line" && !!atom.quiet;
    const prev = items[items.length - 1];
    if (
      joins &&
      prev?.kind === "line" &&
      joinable.has(prev.id) &&
      prev.actorId === atom.actorId &&
      !!prev.quiet === quiet &&
      atom.at - prev.at < MERGE_WINDOW
    ) {
      prev.phrases.push(...phrases);
      continue;
    }
    // One event can give a line and the files that came with it.
    const id = atom.kind === "files" ? `ev-${atom.seq}-${atom.place.id}` : `ev-${atom.seq}`;
    if (joins) joinable.add(id);
    items.push({
      kind: "line",
      id,
      at: atom.at,
      actorId: atom.actorId,
      phrases: [...phrases],
      note: atom.kind === "line" ? atom.note : undefined,
      quiet: quiet || undefined,
    });
  }
  return items;
}

/** An earlier wording of a comment, and when it was replaced. */
export interface Earlier {
  body: string;
  until: number;
}

/** What each edited comment said before, oldest first, by comment id. */
export function commentHistory(events: FeedEvent[]): Dict<Earlier[]> {
  const out: Dict<Earlier[]> = {};
  for (const ev of events) {
    const body = ev.type === "comment.updated" ? ev.data.changes?.body : undefined;
    if (body && typeof body.from === "string") (out[ev.entity_id] ??= []).push({ body: body.from, until: ev.at });
  }
  return out;
}

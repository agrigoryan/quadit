// What the timeline needs to name a thing after it is gone: the rows the
// task's events carried when each thing was made, with the store's copy as
// a fallback for anything older than the events that were loaded.

import { useMemo } from "react";
import { useLookupEvenIfGone } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import type { Attachment, Comment, Decision, FeedEvent, Relation, TaskLink } from "@/types/core";

/** The store's rows the timeline names things from, gone ones included: a deleted comment, a removed file. */
export interface StoredRows {
  comments: Dict<Comment>;
  attachments: Dict<Attachment>;
  links: Dict<TaskLink>;
  relations: Dict<Relation>;
  decisions: Dict<Decision>;
}

export function useStoredRows(): StoredRows {
  const comments = useLookupEvenIfGone("comments");
  const attachments = useLookupEvenIfGone("attachments");
  const links = useLookupEvenIfGone("links");
  const relations = useLookupEvenIfGone("relations");
  const decisions = useLookupEvenIfGone("decisions");
  return useMemo(
    () => ({ comments, attachments, links, relations, decisions }),
    [comments, attachments, links, relations, decisions],
  );
}

export interface Known {
  comments: Dict<Comment>;
  attachments: Dict<Attachment>;
  links: Dict<TaskLink>;
  relations: Dict<Relation>;
  /** Option labels, by option id. */
  options: Dict<string>;
  /** Questions, by decision id. */
  questions: Dict<string>;
  /** When and by whom a question was asked, by decision id and by the id of each of its options. */
  asked: Dict<{ at: number; by: string }>;
}

export function knownRows(events: FeedEvent[], c: StoredRows): Known {
  const known: Known = {
    comments: { ...c.comments },
    attachments: { ...c.attachments },
    links: { ...c.links },
    relations: { ...c.relations },
    options: {},
    questions: {},
    asked: {},
  };
  const decision = (d: Decision) => {
    known.questions[d.id] = d.question;
    const asked = { at: d.created_at, by: d.created_by };
    known.asked[d.id] = asked;
    for (const o of d.options ?? []) {
      known.options[o.id] = o.label;
      known.asked[o.id] = asked;
    }
  };
  for (const d of Object.values(c.decisions)) decision(d);

  for (const ev of events) {
    for (const a of ev.data.attachments ?? []) known.attachments[a.id] = a;
    const row = ev.data.row;
    if (!row) {
      const comment = ev.type === "comment.deleted" ? known.comments[ev.entity_id] : undefined;
      if (comment) known.comments[ev.entity_id] = { ...comment, deleted_at: ev.at };
      continue;
    }
    if (ev.entity_type === "comment") known.comments[ev.entity_id] = row as Comment;
    else if (ev.entity_type === "attachment") known.attachments[ev.entity_id] = row as Attachment;
    else if (ev.entity_type === "link") known.links[ev.entity_id] = row as TaskLink;
    else if (ev.entity_type === "relation") known.relations[ev.entity_id] = row as Relation;
    else if (ev.entity_type === "decision") decision(row as Decision);
  }
  return known;
}

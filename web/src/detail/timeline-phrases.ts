// Turns what the feed records (field: from, to; rows) into what a person
// reads: "moved this from Todo to In progress". Always names, never ids. A
// phrase is the part after the actor's name, so several can share one line.

import { joinPhrases, t } from "@/lib/i18n";
import { getRowEvenIfGone } from "@/data/selectors";
import type { Attachment, Comment, Decision, FeedEvent, Relation, TaskLink } from "@/types/core";
import { linkName, type Side, sideOf, who } from "@/detail/data";
import { docTitle } from "@/docs/data";
import { TIMELINE } from "@/tasks/properties";
import { asText, type Changes, type Phrase } from "@/tasks/properties/property";

/** What a change to the task itself says, around what its properties say (tasks/properties). */
const before: Phrase[] = [
  { field: "title", say: (c) => t("timeline.renamed", { from: asText(c.from), to: asText(c.to) }) },
  { field: "description", say: () => t("timeline.description") },
];
const after: Phrase[] = [
  { field: "archived_at", say: (c) => (c.to ? t("timeline.archived") : t("timeline.unarchived")) },
  { field: "deleted_at", say: (c) => (c.to ? t("timeline.trashed") : t("timeline.restored")) },
];

/** Every field's phrase, in the order they are said in when one line carries several. */
const phrases: Phrase[] = [...before, ...TIMELINE.flatMap((p) => p.timeline ?? []), ...after];

/** The phrases for a set of field changes to the task. Bookkeeping fields have no writer and say nothing. */
export function changePhrases(changes: Changes, actorId: string, data: FeedEvent["data"], taskId: string): string[] {
  const out: string[] = [];
  for (const { field, say } of phrases) {
    const change = changes[field];
    if (!change) continue;
    const said = say(change, { changes, actorId, data, taskId });
    if (Array.isArray(said)) out.push(...said);
    else if (said) out.push(said);
  }
  return out;
}

export function askedPhrase(d: Decision): string {
  return d.asked_id
    ? t("timeline.asked", { name: who(d.asked_id), question: d.question })
    : t("timeline.askedAnyone", { question: d.question });
}

export function pickedPhrase(d: Decision): string {
  const options = d.options ?? getRowEvenIfGone("decisions", d.id)?.options ?? [];
  const option = options.find((o) => o.id === d.picked_option_id);
  const question = d.question;
  switch (d.outcome) {
    case "approved":
      return t("timeline.approved", { question });
    case "declined":
      return t("timeline.declined", { question });
    case "with_changes":
      return option ? t("timeline.pickedChanges", { option: option.label }) : t("timeline.sentBack", { question });
    case "as_is":
      return option ? t("timeline.picked", { option: option.label }) : t("timeline.sentBack", { question });
    default:
      return t("timeline.sentBack", { question });
  }
}

export function relationPhrase(r: Relation, taskId: string): string | null {
  const { side, otherId } = sideOf(r, taskId);
  const key = getRowEvenIfGone("tasks", otherId)?.key;
  return key ? t(`timeline.relation.${side}`, { key }) : null;
}

export function relationRemovedPhrase(r: Relation | undefined, taskId: string): string {
  const key = r ? getRowEvenIfGone("tasks", sideOf(r, taskId).otherId)?.key : undefined;
  return key ? t("timeline.relationRemoved", { key }) : t("timeline.relationRemovedAny");
}

/** A link's name in the history: a page by its title, anything else as its chip names it. */
const nameOf = (link: TaskLink) =>
  link.kind === "doc" ? docTitle(getRowEvenIfGone("docs", link.ref)) : linkName(link);

export function linkPhrase(link: TaskLink): string {
  const kind = (["branch", "commit", "pr", "issue", "doc"] as const).find((k) => k === link.kind) ?? "url";
  return t(`timeline.linked.${kind}`, { name: nameOf(link) });
}

export function linkRemovedPhrase(link: TaskLink | undefined): string {
  return link ? t("timeline.linkRemoved", { name: nameOf(link) }) : t("timeline.linkRemovedAny");
}

/**
 * A relation as told to the task at its far end (the `task.related` event).
 * That task is always the one the relation points at: the blocked one, the
 * original of a duplicate.
 */
export function relatedPhrase(data: FeedEvent["data"]): string | null {
  const key = asText(data.other_key);
  if (!key) return null;
  if (data.removed === true) return t("timeline.relationRemoved", { key });
  const side: Side = data.type === "blocks" ? "blockedBy" : data.type === "duplicates" ? "duplicatedBy" : "relates";
  return t(`timeline.relation.${side}`, { key });
}

/** Where a file was put: on the task itself, on a question, or on one of its options. */
export interface FilePlace {
  on: "task" | "option" | "decision";
  id: string;
  /** The option's label or the question; empty when it is not known. */
  name: string;
}

export function filesPhrase(place: FilePlace, names: string[]): string {
  const list = joinPhrases(names);
  if (place.on === "option" && place.name) return t("timeline.attachedOption", { names: list, option: place.name });
  if (place.on === "decision" && place.name)
    return t("timeline.attachedQuestion", { names: list, question: place.name });
  if (place.on !== "task") return t("timeline.attachedAnyOption", { names: list });
  return t("timeline.attached", { names: list });
}

export function fileRemovedPhrase(a: Attachment | undefined, place: FilePlace | null): string {
  const name = a?.file?.name;
  if (!name) return t("timeline.fileRemovedAny");
  if (place?.on === "option" && place.name) return t("timeline.fileRemovedOption", { name, option: place.name });
  return t("timeline.fileRemoved", { name });
}

export function commentDeletedPhrase(comment: Comment | undefined, actorId: string): string {
  if (!comment || comment.author_id === actorId) return t("timeline.commentDeleted");
  return t("timeline.commentDeletedBy", { name: who(comment.author_id) });
}

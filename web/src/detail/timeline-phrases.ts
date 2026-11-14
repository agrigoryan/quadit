// Turns what the feed records (field: from, to; rows) into what a person
// reads: "moved this from Todo to In progress". Always names, never ids. A
// phrase is the part after the actor's name, so several can share one line.

import { t } from "@/lib/i18n";
import { getState } from "@/lib/store";
import { formatDay } from "@/lib/time";
import type { Decision, FeedEvent, FieldChange, Relation, TaskLink } from "@/lib/types";
import { linkName, sideOf, who } from "@/detail/data";

export type Changes = Record<string, FieldChange>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The order phrases are said in when one line carries several. */
type Writer = (change: FieldChange, ctx: { changes: Changes; actorId: string; data: FeedEvent["data"] }) => string | string[] | null;

const writers: [string, Writer][] = [
  ["title", (c) => t("timeline.renamed", { from: str(c.from), to: str(c.to) })],
  ["description", () => t("timeline.description")],
  [
    "status_id",
    (c) => {
      const { statuses } = getState().c;
      const to = statuses[str(c.to)]?.name;
      const from = statuses[str(c.from)]?.name;
      if (!to) return null;
      return from ? t("timeline.status", { from, to }) : t("timeline.statusTo", { to });
    },
  ],
  [
    "assignee_id",
    (c, { actorId }) => {
      if (!c.to) return t("timeline.unassigned");
      return c.to === actorId ? t("timeline.took") : t("timeline.assigned", { name: who(str(c.to)) });
    },
  ],
  [
    "waiting_on_id",
    (c, { changes }) => {
      if (!c.to) return t("timeline.waitingCleared");
      const note = str(changes.waiting_on_note?.to);
      const name = who(str(c.to));
      return note ? t("timeline.waitingNote", { name, note }) : t("timeline.waiting", { name });
    },
  ],
  [
    "waiting_on_note",
    (c, { changes }) => {
      // Said together with who it is for, when that changed too.
      if (changes.waiting_on_id) return null;
      return c.to ? t("timeline.noteSet", { note: str(c.to) }) : t("timeline.noteCleared");
    },
  ],
  [
    "priority",
    (c) => {
      const p = Number(c.to) || 0;
      return p ? t("timeline.priority", { name: t(`priority.${p}` as "priority.1") }) : t("timeline.priorityCleared");
    },
  ],
  [
    "label_ids",
    (c) => {
      const { labels } = getState().c;
      const before = ids(c.from);
      const after = ids(c.to);
      const names = (list: string[]) => list.map((id) => labels[id]?.name).filter((n): n is string => !!n);
      const added = names(after.filter((id) => !before.includes(id)));
      const removed = names(before.filter((id) => !after.includes(id)));
      const out: string[] = [];
      if (added.length) out.push(t("timeline.labelAdded", { n: added.length, names: joinPhrases(added) }));
      if (removed.length) out.push(t("timeline.labelRemoved", { n: removed.length, names: joinPhrases(removed) }));
      return out;
    },
  ],
  [
    "epic_id",
    (c) => {
      const name = getState().c.epics[str(c.to)]?.name;
      return name ? t("timeline.epic", { name }) : c.to ? null : t("timeline.epicCleared");
    },
  ],
  [
    "milestone_id",
    (c) => {
      const name = getState().c.milestones[str(c.to)]?.name;
      return name ? t("timeline.milestone", { name }) : c.to ? null : t("timeline.milestoneCleared");
    },
  ],
  [
    "cycle_id",
    (c) => {
      const cycle = getState().c.cycles[str(c.to)];
      if (cycle) return t("timeline.cycle", { name: cycle.name || t("prop.cycleName", { n: cycle.number }) });
      return c.to ? null : t("timeline.cycleCleared");
    },
  ],
  [
    "estimate",
    (c) => {
      const n = Number(c.to) || 0;
      return n ? t("timeline.estimate", { points: t("prop.points", { n }) }) : t("timeline.estimateCleared");
    },
  ],
  ["due_on", (c) => (c.to ? t("timeline.due", { day: formatDay(str(c.to)) }) : t("timeline.dueCleared"))],
  [
    "parent_id",
    (c) => {
      const key = getState().c.tasks[str(c.to)]?.key;
      return key ? t("timeline.parent", { key }) : c.to ? null : t("timeline.parentCleared");
    },
  ],
  ["project_id", (_c, { data }) => (data.moved_from ? t("timeline.movedProject", { key: str(data.moved_from) }) : null)],
  ["archived_at", (c) => (c.to ? t("timeline.archived") : t("timeline.unarchived"))],
  ["deleted_at", (c) => (c.to ? t("timeline.trashed") : t("timeline.restored"))],
];

/** The phrases for a set of field changes. Bookkeeping fields have no writer and say nothing. */
export function changePhrases(changes: Changes, actorId: string, data: FeedEvent["data"]): string[] {
  const out: string[] = [];
  for (const [field, write] of writers) {
    const change = changes[field];
    if (!change) continue;
    const said = write(change, { changes, actorId, data });
    if (Array.isArray(said)) out.push(...said);
    else if (said) out.push(said);
  }
  return out;
}

const listed = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

/** "a", "a and b", "a, b, and c", as the reader's language lists things. */
export const joinPhrases = (parts: string[]): string => listed.format(parts);

export function askedPhrase(d: Decision): string {
  return d.asked_id ? t("timeline.asked", { name: who(d.asked_id), question: d.question }) : t("timeline.askedAnyone", { question: d.question });
}

export function pickedPhrase(d: Decision): string {
  const options = d.options ?? getState().c.decisions[d.id]?.options ?? [];
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
  const key = getState().c.tasks[otherId]?.key;
  return key ? t(`timeline.relation.${side}`, { key }) : null;
}

export function relationRemovedPhrase(r: Relation | undefined, taskId: string): string {
  const key = r ? getState().c.tasks[sideOf(r, taskId).otherId]?.key : undefined;
  return key ? t("timeline.relationRemoved", { key }) : t("timeline.relationRemovedAny");
}

export function linkPhrase(link: TaskLink): string {
  const kind = (["branch", "commit", "pr"] as const).find((k) => k === link.kind) ?? "url";
  return t(`timeline.linked.${kind}`, { name: linkName(link) });
}

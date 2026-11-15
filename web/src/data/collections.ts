// The shape of the browser's copy: every collection with the type of its
// rows, which collection each kind of feed entity lives in, and the key a
// row is filed under. data/store.ts holds the copy; data/apply.ts changes it.

import type {
  AgentSession,
  Attachment,
  Comment,
  Cycle,
  Decision,
  Epic,
  Label,
  Member,
  Milestone,
  Notification,
  Project,
  Relation,
  Secret,
  Status,
  Task,
  TaskLink,
  Template,
  View,
  Watcher,
} from "@/types/core";
import type { Claim, Resource } from "@/types/agents";
import type { Integration, Rule, Webhook } from "@/types/automation";
import type { BlockRow, Doc } from "@/types/docs";
import type { Preference } from "@/types/plan";

export type Dict<T> = Record<string, T>;

/** A row of any collection, as the code that files rows of every kind sees it. */
export type AnyRow = Record<string, unknown>;

/**
 * Every row type here is a `type`, not an `interface`: only a type has the
 * implicit index signature that lets the code filing rows of every kind
 * (CopyOnWrite, data/mutate.ts) see a table as Dict<AnyRow>. An interface
 * here fails the type check in data/apply.ts.
 */
export interface Collections {
  tasks: Dict<Task>;
  comments: Dict<Comment>;
  decisions: Dict<Decision>;
  projects: Dict<Project>;
  statuses: Dict<Status>;
  labels: Dict<Label>;
  members: Dict<Member>;
  epics: Dict<Epic>;
  milestones: Dict<Milestone>;
  cycles: Dict<Cycle>;
  views: Dict<View>;
  templates: Dict<Template>;
  preferences: Dict<Preference>;
  attachments: Dict<Attachment>;
  relations: Dict<Relation>;
  links: Dict<TaskLink>;
  notifications: Dict<Notification>;
  watchers: Dict<Watcher>;
  sessions: Dict<AgentSession>;
  resources: Dict<Resource>;
  claims: Dict<Claim>;
  docs: Dict<Doc>;
  blocks: Dict<BlockRow>;
  webhooks: Dict<Webhook>;
  rules: Dict<Rule>;
  integrations: Dict<Integration>;
  /** Not in the starting copy: the secrets page fetches them (settings/secrets/data.ts). */
  secrets: Dict<Secret>;
}

export type CollectionName = keyof Collections;

/** Which collection an event's entity_type lives in. */
export const COLLECTION_OF: Record<string, CollectionName> = {
  task: "tasks",
  comment: "comments",
  decision: "decisions",
  project: "projects",
  status: "statuses",
  label: "labels",
  member: "members",
  epic: "epics",
  milestone: "milestones",
  cycle: "cycles",
  view: "views",
  template: "templates",
  preference: "preferences",
  attachment: "attachments",
  relation: "relations",
  link: "links",
  notification: "notifications",
  watcher: "watchers",
  session: "sessions",
  resource: "resources",
  claim: "claims",
  doc: "docs",
  block: "blocks",
  webhook: "webhooks",
  rule: "rules",
  integration: "integrations",
  secret: "secrets",
};

export const emptyCollections = (): Collections => {
  const c = {} as Record<CollectionName, Dict<never>>;
  for (const name of new Set(Object.values(COLLECTION_OF))) c[name] = {};
  return c;
};

/** Members are keyed by user id; a watcher has no id of its own. */
export function keyOf(collection: CollectionName, row: AnyRow): string {
  if (collection === "members") return String(row.user_id);
  if (collection === "watchers") return `${String(row.user_id)}:${String(row.subject_id)}`;
  return String(row.id);
}

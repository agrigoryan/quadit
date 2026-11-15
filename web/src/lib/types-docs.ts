// Pages, their blocks and databases as the server sends them
// (internal/core/pages.go; Ref in internal/core/tasks.go).

import type { Comment } from "@/lib/types";

export type DocKind = "page" | "database" | "row";

/** A page, a database or a row of one (core.Doc). */
export type Doc = {
  id: string;
  parent_id?: string;
  kind: DocKind;
  title: string;
  /** An emoji, or a name the server uses for pages it makes ("git", "brain"). */
  icon?: string;
  cover?: string;
  project_id?: string;
  /** Set on a private page: only the owner and `shared_with` see it. */
  owner_id?: string;
  shared_with?: string[];
  /** decision_log, changelog or open_questions: built from data, read-only. */
  generated?: string;
  /** The agent whose notes this page holds. */
  memory_of?: string;
  /** A database row's values, by property id. */
  props?: Record<string, unknown>;
  source_id?: string;
  source_path?: string;
  rank: string;
  created_by: string;
  created_at: number;
  updated_by?: string;
  updated_at: number;
  /** The seq fields are absent on a page made here until the server's row arrives. */
  created_seq?: number;
  updated_seq?: number;
  /** The last change to its blocks. */
  content_seq?: number;
  archived_at?: number;
  deleted_at?: number;
};

/** One stored block of a page: a flat row with its parent and place (core.Block). */
export type BlockRow = {
  id: string;
  doc_id: string;
  parent_id?: string;
  rank: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  created_by: string;
  updated_by: string;
  created_seq: number;
  updated_seq: number;
  deleted_at?: number;
};

/** A block with its nested blocks, as versions and Markdown conversion give it. */
export interface BlockTree {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockTree[];
}

/** A saved snapshot of a page, listed without the snapshot itself (core.DocVersion). */
export interface DocVersion {
  id: string;
  doc_id: string;
  seq: number;
  label?: string;
  title: string;
  created_by: string;
  created_at: number;
}

export const PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "member",
  "relation",
  "rollup",
  "formula",
  "created_at",
  "updated_at",
  "created_by",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Property types whose cells are worked out, never typed in. */
export const COMPUTED_TYPES: PropertyType[] = ["formula", "rollup", "created_at", "updated_at", "created_by"];

export const OPTION_COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"] as const;

export interface SelectOption {
  name: string;
  color?: string;
}

export interface PropConfig {
  options?: SelectOption[];
  formula?: string;
  /** relation: the database it points into. */
  database?: string;
  /** rollup: the relation property to follow, the property to read there, and how to combine. */
  relation?: string;
  target?: string;
  fn?: string;
}

/** A column of a database (core.DBProperty). */
export interface DBProperty {
  id: string;
  database_id: string;
  name: string;
  type: PropertyType;
  config?: PropConfig;
  rank: string;
  /** Absent on one made here until the server's row arrives. */
  updated_seq?: number;
  deleted_at?: number;
}

export const VIEW_TYPES = ["table", "board", "calendar", "gallery", "timeline", "form"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export type FilterOp = "is" | "is_not" | "contains" | "gt" | "lt" | "empty" | "not_empty" | "checked" | "unchecked";

/** One condition of a view. `prop` is a property id, or "title". */
export interface RowFilter {
  prop: string;
  op: FilterOp;
  value?: unknown;
}

export interface RowSort {
  prop: string;
  desc?: boolean;
}

/** What a view keeps in its config. `filters` and `sorts` are also read by the server (rows?view=). */
export interface ViewConfig {
  filters?: RowFilter[];
  sorts?: RowSort[];
  /** Property ids not shown. */
  hidden?: string[];
  /** Property ids in this view's own column order; the rest follow by rank. */
  order?: string[];
  /** Column widths in the table, by property id ("title" for the first). */
  widths?: Record<string, number>;
  /** board: the select property whose options are the columns. */
  group_by?: string;
  /** calendar: the date property. timeline: the start date. */
  date_prop?: string;
  /** timeline: the end date. */
  end_prop?: string;
  /** form: the properties asked for, in order. */
  form_props?: string[];
  form_intro?: string;
}

/** A saved way to show a database (core.DBView). */
export interface DBView {
  id: string;
  database_id: string;
  name: string;
  type: ViewType;
  config?: ViewConfig;
  rank: string;
  /** Absent on one made here until the server's row arrives. */
  updated_seq?: number;
  deleted_at?: number;
}

/** A mention or link between two things (core.Ref). */
export interface DocRef {
  from_type: string;
  from_id: string;
  from_scope_type: string;
  from_scope_id: string;
  to_type: string;
  to_id: string;
}

/** A tree of pages synced with a folder of Markdown in a git repository (core.DocSource). */
export interface DocSource {
  id: string;
  root_doc_id: string;
  repo: string;
  branch?: string;
  subdir?: string;
  authority: "repo" | "pages";
  write_mode: "commit" | "propose" | "none";
  last_commit?: string;
  last_sync_at?: number;
  last_error?: string;
  created_by: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
}

/** A comment on a page or one of its blocks: one with `doc_id` set. */
export type DocComment = Comment;

/** What GET /docs/{id} answers. */
export interface PageData {
  doc: Doc;
  blocks: BlockRow[];
  children: Doc[];
  comments: DocComment[];
  mentioned_in: DocRef[];
  mentions: DocRef[];
  source?: DocSource;
  properties?: DBProperty[];
  views?: DBView[];
  rows?: Doc[];
}

/** A member with a page open, and the block they are in (core.Presence). */
export interface PresenceEntry {
  user_id: string;
  block?: string;
  at: number;
}

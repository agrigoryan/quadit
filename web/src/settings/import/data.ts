// Bringing work in from other tools: what each source needs, and the one
// call that reads it (POST /import). The server reads an uploaded export or
// an address, and writes what it finds as the person who asked.

import { api, ws } from "@/lib/api";
import { t } from "@/lib/i18n";

export type ImportKind = "linear" | "asana" | "trello" | "notion" | "obsidian" | "markdown" | "github" | "orbit";

export interface Source {
  kind: ImportKind;
  /** A file is uploaded (and of which kind), or the source is read from its address. */
  from: "file" | "address";
  /** What the file chooser offers. */
  accept?: string;
  /** Its tasks go into a project the person chooses. */
  project: boolean;
}

export const SOURCES: Source[] = [
  { kind: "linear", from: "file", accept: ".csv,text/csv", project: true },
  { kind: "asana", from: "file", accept: ".csv,text/csv", project: true },
  { kind: "trello", from: "file", accept: ".json,application/json", project: true },
  { kind: "github", from: "address", project: true },
  { kind: "notion", from: "file", accept: ".zip,application/zip", project: false },
  { kind: "obsidian", from: "file", accept: ".zip,application/zip", project: false },
  { kind: "markdown", from: "file", accept: ".zip,application/zip", project: false },
  { kind: "orbit", from: "address", project: false },
];

export interface ImportRequest {
  kind: ImportKind;
  /** The id of the uploaded export. */
  file?: string;
  /** github: owner/repo; orbit: the install's address. */
  source?: string;
  options: Record<string, string>;
}

export interface Found {
  tasks: number;
  pages: number;
  databases: number;
}

export interface ImportResult {
  found: Found;
  made: { tasks: number; comments: number; pages: number; rows: number; files: number };
  /** Assignees named in the source that are not members here. */
  unmatched_people?: string[];
  summary?: string;
  log?: string[];
}

/** Reads the source and says what is in it, without writing anything. */
export const checkImport = (slug: string, req: ImportRequest) =>
  api.post<{ found: Found }>(ws(slug, "/import"), { ...req, dry_run: true }).then((r) => r.found);

export const runImport = (slug: string, req: ImportRequest) => api.post<ImportResult>(ws(slug, "/import"), req);

type CountKey = "tasks" | "pages" | "databases" | "comments" | "rows" | "files";

/** "120 tasks, 14 pages": the counts that are not zero, in the order given. */
export function countList(counts: Partial<Record<CountKey, number>>, order: CountKey[]): string {
  return order
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => t(`import.n.${key}`, { n: counts[key] ?? 0 }))
    .join(", ");
}

export const foundText = (found: Found): string => {
  const list = countList(found, ["tasks", "pages", "databases"]);
  return list ? t("import.found", { list }) : t("import.foundNothing");
};

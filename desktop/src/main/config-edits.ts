// Edits to other programs' files (harness settings, skill files, the quadit
// command's link, its folder and the line in a shell profile that puts that
// folder on the PATH; on Windows the person's PATH itself, which the
// registry keeps: windows-environment.ts), planned first and written only
// once the person has seen them, and each recorded so that it can be taken
// back later, but only where the file still says what was written.
//
// A change is planned against the files as they are now, into the text each
// file will have (FileEdit) and a record of what was done (Applied). JSON
// and JSONC are edited with jsonc-parser, which keeps comments and
// formatting. TOML is edited only by appending a table, never by rewriting
// it: a table that is already there is refused with what to add by hand.
// Writing checks first that every file is still as planned.
//
// A path is planned as the file it really is: through a symbolic link in
// it (dotfiles kept in a repository and linked home, say), the plan shows
// and edits the file the link leads to, and the link stays a link.
//
// On Windows a file's mode is only whether it is read-only: the modes given
// here (0600 for what may hold a token) then mean nothing more, and what
// keeps such a file the person's own is where it is, in their profile's
// folders, which Windows gives to them alone.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { readUserVariable, writeUserVariable } from "@/main/windows-environment";
import { applyEdits, type ModificationOptions, modify, type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/** A change the app may make to a file. */
export type Change =
  /** Sets a key of a JSON or JSONC file to `value`. */
  | { kind: "json"; path: string; keyPath: string[]; value: unknown }
  /** Adds the string `value` to the array at a key of a JSON or JSONC file, when it is not there. */
  | { kind: "json-item"; path: string; keyPath: string[]; value: string }
  /**
   * Appends a table `[table]` holding `entries` to a TOML file. With
   * `intoExisting`, a table there already gets the entries it lacks instead,
   * right under its header; one it sets otherwise is the person's and refused.
   */
  | {
      kind: "toml";
      path: string;
      table: string[];
      entries: Record<string, string | boolean>;
      intoExisting?: true;
    }
  /** Writes a whole file. */
  | { kind: "file"; path: string; content: string }
  /**
   * A file another program writes (quadit login): planned and backed up
   * here, written by that program. `shown` is what the plan shows of it.
   */
  | { kind: "written-by"; path: string; shown: string }
  /** Makes `path` a symbolic link to `target`. */
  | { kind: "link"; path: string; target: string }
  /** Makes the folder `path`, where there is none. */
  | { kind: "folder"; path: string }
  /** Adds the whole line `line` (which says it was added by the app) to the end of a text file, unless it has it. */
  | { kind: "line"; path: string; line: string }
  /** Adds `folder` to the end of the person's PATH (Windows; `path` is USER_PATH), unless it is on it. */
  | { kind: "path"; path: string; folder: string };

/**
 * What a change did, enough to take it back: the value a key had (absent
 * when it had none) and the value written, how many keys of its path were
 * there before, the block appended, a file's hash and its backup.
 */
export type Applied =
  | { kind: "json"; path: string; keyPath: string[]; prior?: unknown; wrote: unknown; existed: number }
  | { kind: "json-item"; path: string; keyPath: string[]; value: string; existed: number }
  /** `within`: the entries `block` added inside a table that was there already (intoExisting). */
  | { kind: "toml"; path: string; table: string[]; block: string; within?: Record<string, string | boolean> }
  | { kind: "file"; path: string; sha256: string; backup: string | null }
  | { kind: "link"; path: string; target: string }
  | { kind: "folder"; path: string }
  /** `created`: the file was not there before the line. */
  | { kind: "line"; path: string; line: string; created: boolean }
  /** `created`: the person had no PATH of their own before. */
  | { kind: "path"; path: string; folder: string; created: boolean };

/** A file as it is and as it will be: text, for a link its target, for a folder ""; null for none. */
export interface FileEdit {
  path: string;
  /** The kind of the first change (or record) that made it: what the file is to the plan, in a word. */
  kind: Change["kind"] | Applied["kind"];
  link: boolean;
  folder?: true;
  before: string | null;
  after: string | null;
  /** Written by another program (quadit login): `after` is only what the plan shows. */
  writtenBy?: true;
  /** The person's PATH: where backUp keeps it, which is written again with the value the edit really replaces. */
  backup?: string;
}

/** A plan that cannot be made, with what the person should know. */
export class EditRefused extends Error {}

/**
 * The person's own PATH on Windows, as the registry names it: what a "path"
 * change's `path` is, and the name its plan shows.
 */
export const USER_PATH = "HKEY_CURRENT_USER\\Environment\\Path";
/** The variable USER_PATH is, among the person's own. */
const PATH_VARIABLE = "Path";

const JSON_FORMAT: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
const TOML_MARK = "# Added by the Quadit app; Disconnect in the app takes it out.";

/**
 * The edits that make `changes`, from the files as they are now, and what
 * each change did. Several changes to one file are made one after another
 * on its text. A change that finds its result already there does nothing
 * and records nothing. Throws EditRefused when a file cannot be read or a
 * TOML table is already there.
 */
export function planChanges(changes: Change[]): { edits: FileEdit[]; applied: Applied[] } {
  const edits = new Map<string, FileEdit>();
  const applied: Applied[] = [];
  for (const asked of changes) {
    if (asked.kind !== "link" && asked.kind !== "path") refuseDanglingLink(asked.path);
    const change = { ...asked, path: changedPath(asked) };
    let edit = edits.get(change.path);
    if (!edit) {
      edit = editOf(change.path, change.kind);
      edits.set(change.path, edit);
    }
    const done = applyChange(edit, change);
    if (done) applied.push(done);
  }
  return { edits: [...edits.values()].filter((e) => e.after !== e.before || e.writtenBy), applied };
}

function applyChange(edit: FileEdit, change: Change): Applied | null {
  const { path } = change;
  switch (change.kind) {
    case "json": {
      const text = edit.after ?? "";
      const root = readJson(text, path);
      const { value: prior, existed } = lookUp(root, change.keyPath);
      if (existed === change.keyPath.length && same(prior, change.value)) return null;
      edit.after = applyEdits(text, modify(text, change.keyPath, change.value, JSON_FORMAT));
      return { kind: "json", path, keyPath: change.keyPath, prior, wrote: change.value, existed };
    }
    case "json-item": {
      const text = edit.after ?? "";
      const { value: list, existed } = lookUp(readJson(text, path), change.keyPath);
      if (list !== undefined && !Array.isArray(list)) {
        throw new EditRefused(`${path}: ${change.keyPath.join(".")} is not a list, so the app cannot add to it.`);
      }
      if (list?.includes(change.value)) return null;
      edit.after = applyEdits(
        text,
        modify(text, [...change.keyPath, -1], change.value, { ...JSON_FORMAT, isArrayInsertion: true }),
      );
      return { kind: "json-item", path, keyPath: change.keyPath, value: change.value, existed };
    }
    case "toml": {
      const text = edit.after ?? "";
      let root = readToml(text, path);
      const name = change.table.join(".");
      const there = lookUp(root, change.table);
      if (change.intoExisting && there.existed === change.table.length && typeof there.value === "object") {
        const added = addToTable(edit, change, there.value as Record<string, unknown>);
        if (added !== "no header") return added;
      }
      const block = `${text === "" || text.endsWith("\n") ? "" : "\n"}\n${TOML_MARK}\n${stringifyToml(nest(change.table, change.entries))}\n`;
      for (let i = 1; i <= change.table.length; i++) {
        const found = lookUp(root, change.table.slice(0, i));
        if (found.existed === i && (i === change.table.length || typeof found.value !== "object")) {
          throw new EditRefused(
            `${path} already has ${name}, so the app does not change it. Add these lines to it yourself, or take it out and try again:\n${block.trim()}`,
          );
        }
      }
      // Appended to whatever the file has, the table must still read as TOML (a dotted key elsewhere may define it).
      root = readToml(text + block, path);
      if (lookUp(root, change.table).existed !== change.table.length) throw new Error(`${path}: ${name} was not added`);
      edit.after = text + block;
      return { kind: "toml", path, table: change.table, block };
    }
    case "file":
      if (edit.after === change.content) return null;
      edit.after = change.content;
      return { kind: "file", path, sha256: "", backup: null };
    case "written-by":
      edit.after = change.shown;
      edit.writtenBy = true;
      return { kind: "file", path, sha256: "", backup: null };
    case "link":
      // Whatever is there (a file, another link, a broken one) is the person's: never replaced.
      if (edit.before !== null && edit.before !== change.target) {
        throw new EditRefused(
          `${path} is already there and the app did not make it: take it away, or put quadit on your PATH yourself.`,
        );
      }
      if (edit.after === change.target) return null;
      edit.after = change.target;
      return { kind: "link", path, target: change.target };
    case "folder":
      if (edit.after !== null) return null;
      edit.after = "";
      return { kind: "folder", path };
    case "line": {
      const text = edit.after ?? "";
      if (text.split("\n").includes(change.line)) return null;
      edit.after = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${change.line}\n`;
      return { kind: "line", path, line: change.line, created: edit.before === null };
    }
    case "path": {
      const text = edit.after ?? "";
      if (pathEntries(text).some((entry) => sameFolder(entry, change.folder))) return null;
      edit.after = `${text}${text === "" || text.endsWith(";") ? "" : ";"}${change.folder}`;
      return { kind: "path", path: USER_PATH, folder: change.folder, created: edit.before === null };
    }
  }
}

/** The folders of a PATH's value, in order; none for no value. Windows passes over an empty one (";;"), and so does the app. */
function pathEntries(value: string | null): string[] {
  return (value ?? "").split(";").filter((entry) => entry.trim() !== "");
}

/** Whether two folders of a PATH are the same: Windows reads them in any case, with or without a closing backslash. */
function sameFolder(a: string, b: string): boolean {
  const plain = (folder: string) => folder.trim().replace(/\\+$/, "").toLowerCase();
  return plain(a) === plain(b);
}

/**
 * Adds to the table `change` names, there already in `edit`'s text, the
 * entries it lacks: marked lines right under its header, its other entries
 * untouched. An entry it sets otherwise is the person's choice: refused,
 * saying so. Nothing to add, null; a table without a header of its own
 * (dotted keys), "no header", for the caller's usual way.
 */
function addToTable(
  edit: FileEdit,
  change: Extract<Change, { kind: "toml" }>,
  table: Record<string, unknown>,
): Applied | null | "no header" {
  const name = change.table.join(".");
  const missing: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(change.entries)) {
    if (!Object.hasOwn(table, key)) missing[key] = value;
    else if (!same(table[key], value)) {
      const theirs = stringifyToml({ [key]: table[key] }).trim();
      throw new EditRefused(`${change.path} sets ${theirs} in [${name}]: that is your setting, so the app leaves it.`);
    }
  }
  if (Object.keys(missing).length === 0) return null;
  const text = edit.after ?? "";
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^\s*\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/.exec(line)?.[1] === name);
  if (header < 0) return "no header";
  const block = Object.entries(missing)
    .map(([key, value]) => `${stringifyToml({ [key]: value }).trim()}  ${TOML_MARK}\n`)
    .join("");
  lines.splice(header + 1, 0, block.slice(0, -1));
  const after = lines.join("\n");
  const now = lookUp(readToml(after, change.path), change.table).value as Record<string, unknown>;
  if (Object.entries(missing).some(([key, value]) => !same(now[key], value)))
    throw new Error(`${change.path}: ${name} was not added to`);
  edit.after = after;
  return { kind: "toml", path: change.path, table: change.table, block, within: missing };
}

/**
 * The edits that take back what `applied` did, where each file still says
 * what was written, and a note for each that no longer does. A file that
 * is gone, or a key or block no longer there, needs nothing. The last
 * record is taken back first: a key written twice (a setting added to it
 * later) goes back through each value it had.
 */
export function planReverts(applied: Applied[]): { edits: FileEdit[]; notes: string[] } {
  // A folder last, as shown and as written: what is in it goes first. Otherwise the files in the order they were
  // written, each taken back last record first.
  const folderLast = [...applied.filter((r) => r.kind !== "folder"), ...applied.filter((r) => r.kind === "folder")];
  const edits = new Map<string, FileEdit>();
  for (const record of folderLast)
    if (!edits.has(record.path)) edits.set(record.path, editOf(record.path, record.kind));
  const notes: string[] = [];
  const last = [...applied].reverse();
  const ordered = [...last.filter((r) => r.kind !== "folder"), ...last.filter((r) => r.kind === "folder")];
  for (const record of ordered) {
    const edit = edits.get(record.path);
    if (!edit || edit.after === null) continue;
    const kept = revertOne(edit, record, edits);
    if (kept) notes.push(`${record.path}: ${kept}; left as it is.`);
  }
  return { edits: [...edits.values()].filter((e) => e.after !== e.before), notes };
}

/**
 * Takes back one record on `edit`'s text; gives why not when the file no
 * longer says what was written. `edits` are the other files this revert
 * changes: a folder goes only when what is in it goes.
 */
function revertOne(edit: FileEdit, record: Applied, edits: Map<string, FileEdit>): string | null {
  const text = edit.after ?? "";
  switch (record.kind) {
    case "json": {
      const { value, existed } = lookUp(readJson(text, record.path), record.keyPath);
      if (existed < record.keyPath.length) return null;
      if (!same(value, record.wrote)) return `${record.keyPath.join(".")} changed since the app set it`;
      const after = applyEdits(text, modify(text, record.keyPath, record.prior, JSON_FORMAT));
      edit.after = prune(after, record, record.keyPath.length - 1);
      return null;
    }
    case "json-item": {
      const { value } = lookUp(readJson(text, record.path), record.keyPath);
      const index = Array.isArray(value) ? value.indexOf(record.value) : -1;
      if (index < 0) return null;
      const after = applyEdits(text, modify(text, [...record.keyPath, index], undefined, JSON_FORMAT));
      edit.after = prune(after, record, record.keyPath.length);
      return null;
    }
    case "toml": {
      if (record.within) {
        if (!text.includes(record.block)) return null;
        const now = lookUp(readToml(text, record.path), record.table).value as Record<string, unknown> | undefined;
        if (Object.entries(record.within).some(([key, value]) => !same(now?.[key], value)))
          return "the setting the app added changed since";
        edit.after = text.replace(record.block, "");
        return null;
      }
      if (!text.includes(record.block))
        return text.includes(TOML_MARK) ? "the table the app added changed since" : null;
      // An entry added below the block belongs to its table: taking the block out would give it to the table before.
      const now = lookUp(readToml(text, record.path), record.table).value;
      if (!same(now, lookUp(readToml(record.block, record.path), record.table).value)) {
        return "the table the app added changed since";
      }
      edit.after = text.replace(record.block, "");
      return null;
    }
    case "file":
      if (sha256(text) !== record.sha256) return "it changed since the app wrote it";
      edit.after = record.backup ? readFileSync(record.backup, "utf8") : null;
      return null;
    case "link":
      if (text !== record.target) return "it no longer links to the app's quadit";
      edit.after = null;
      return null;
    case "folder": {
      // It holds files of the person's now: it stays, with nothing to say about it.
      const left = readdirSync(record.path).filter((name) => edits.get(join(record.path, name))?.after !== null);
      if (left.length === 0) edit.after = null;
      return null;
    }
    case "line": {
      const lines = text.split("\n");
      const at = lines.indexOf(record.line);
      if (at < 0) return null;
      lines.splice(at, 1);
      const rest = lines.join("\n");
      edit.after = record.created && rest.trim() === "" ? null : rest;
      return null;
    }
    case "path": {
      // Every folder of the PATH but the one the app added stays as it was written, empty places and all.
      const entries = text.split(";");
      const kept = entries.filter((entry) => !sameFolder(entry, record.folder));
      if (kept.length === entries.length) return null;
      const rest = kept.join(";");
      edit.after = record.created && pathEntries(rest).length === 0 ? null : rest;
      return null;
    }
  }
}

/**
 * Removes the objects and lists on a record's key path, from `depth` keys
 * deep up, that the app made (deeper than the keys that were there) and
 * that are empty now.
 */
function prune(text: string, record: { path: string; keyPath: string[]; existed: number }, depth: number): string {
  for (; depth > record.existed; depth--) {
    const keyPath = record.keyPath.slice(0, depth);
    const { value } = lookUp(readJson(text, record.path), keyPath);
    const empty = Array.isArray(value) ? value.length === 0 : !!value && Object.keys(value).length === 0;
    if (!empty) break;
    text = applyEdits(text, modify(text, keyPath, undefined, JSON_FORMAT));
  }
  return text;
}

/** The first edit whose file is no longer as it was when planned, or null when none is. */
export function changedSince(edits: FileEdit[]): FileEdit | null {
  return edits.find((edit) => editOf(edit.path, edit.kind).before !== edit.before) ?? null;
}

/** An edit of `path` that changes nothing yet, as a change of `kind` reads it: a link's target, a folder, the person's PATH, or text. */
function editOf(path: string, kind: Change["kind"] | Applied["kind"]): FileEdit {
  if (kind === "path") {
    const before = readPath();
    return { path, kind, link: false, before, after: before };
  }
  if (kind === "link") {
    const before = readLink(path);
    return { path, kind, link: true, before, after: before };
  }
  if (kind === "folder") {
    const before = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? "" : null;
    return { path, kind, link: false, folder: true, before, after: before };
  }
  const before = readText(path);
  return { path, kind, link: false, before, after: before };
}

/**
 * Copies every file `edits` replace into `backupDir` (0600: a backup may
 * hold a token), and the person's PATH as it was into a file there; gives
 * each backed-up path's copy, named after the path ("Users__ann__.zshrc",
 * "C__Users__ann__.claude__settings.json").
 */
export function backUp(edits: FileEdit[], backupDir: string): Map<string, string> {
  const backups = new Map<string, string>();
  for (const edit of edits) {
    if (edit.before === null || edit.link || edit.folder) continue;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = join(backupDir, edit.path.replace(/^[\\/]+/, "").replaceAll(/:?[\\/]+/g, "__"));
    if (edit.kind === "path") {
      writeFileSync(backup, edit.before, { mode: 0o600 });
      edit.backup = backup;
    } else copyFileSync(edit.path, backup);
    chmodSync(backup, 0o600);
    backups.set(edit.path, backup);
  }
  return backups;
}

/** Writes the edits, except those another program writes. */
export function writeEdits(edits: FileEdit[]) {
  for (const edit of edits) {
    if (edit.writtenBy) continue;
    if (edit.kind === "path") writePath(edit);
    else if (edit.folder) {
      if (edit.after === null) rmdirSync(edit.path);
      else mkdirSync(edit.path, { recursive: true });
    } else if (edit.after === null) rmSync(edit.path, { force: true });
    else if (edit.link) {
      rmSync(edit.path, { force: true });
      symlinkSync(edit.after, edit.path);
    } else writeText(edit.path, edit.after);
  }
}

/**
 * Makes the person's PATH what `edit` makes of it, from the value it has
 * now: the plan was made from the value then, and something else (an
 * installer) may have changed it while Connect waited for a token and a
 * login. The folders the edit adds are added to it where missing, those it
 * takes out are taken out, and the rest is kept as it is now, its type too
 * (a PATH that names %USERPROFILE% stays one Windows expands). The value
 * really replaced is what the backup keeps.
 */
function writePath(edit: FileEdit) {
  const now = readUserVariable(PATH_VARIABLE);
  const planned = pathEntries(edit.before);
  const wanted = pathEntries(edit.after);
  const added = wanted.filter((entry) => !planned.some((was) => sameFolder(was, entry)));
  const removed = planned.filter((was) => !wanted.some((entry) => sameFolder(was, entry)));
  let text = (now?.value ?? "")
    .split(";")
    .filter((entry) => !removed.some((gone) => sameFolder(entry, gone)))
    .join(";");
  for (const folder of added)
    if (!pathEntries(text).some((entry) => sameFolder(entry, folder)))
      text = `${text}${text === "" || text.endsWith(";") ? "" : ";"}${folder}`;
  if (edit.backup && now) writeFileSync(edit.backup, now.value, { mode: 0o600 });
  const gone = edit.after === null && pathEntries(text).length === 0;
  writeUserVariable(PATH_VARIABLE, gone ? null : { value: text, expand: now?.expand ?? true });
}

/** Writes beside and renames over, keeping the file's mode, so a reader never sees half a file. */
function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // A new file.
  }
  // A name of its own, made here and nowhere else ("wx"): a file or link already there is never written through.
  const next = `${path}.quadit-${randomBytes(6).toString("hex")}`;
  writeFileSync(next, text, { mode, flag: "wx" });
  chmodSync(next, mode);
  renameSync(next, path);
}

/** The unified diff of an edit, as the plan shows it, with every token masked on both sides; a PATH a folder a line. */
export function diffOf(edit: FileEdit): string {
  if (edit.folder) {
    return edit.after === null ? `-(the folder, empty now)\n` : `+(a new folder)\n`;
  }
  const show = (side: string | null) =>
    side === null
      ? ""
      : edit.link
        ? `→ ${side}\n`
        : edit.kind === "path"
          ? pathEntries(side)
              .map((entry) => `${entry}\n`)
              .join("")
          : masked(side);
  return createTwoFilesPatch(edit.path, edit.path, show(edit.before), show(edit.after), "", "", { context: 3 })
    .split("\n")
    .slice(2)
    .join("\n");
}

/** `text` with Quadit's tokens (qd_…) and the value of every "token" key masked. */
function masked(text: string): string {
  return text.replace(/qd_[A-Za-z0-9_-]+/g, "qd_…").replace(/("token"\s*:\s*")(?!qd_…")[^"]*"/g, '$1…"');
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The file a change is to: the one its path really is, or for a link, the link in the folder its path really is; the person's PATH is no file. */
function changedPath(change: { kind: string; path: string }): string {
  if (change.kind === "path") return change.path;
  return change.kind === "link" ? join(realPath(dirname(change.path)), basename(change.path)) : realPath(change.path);
}

/**
 * What a change or a record is a change to (a key of a file, a file, a
 * link), the same for a change and the record of one like it: two
 * harnesses that need the same change share it.
 */
export function targetOf(item: Change | Applied): string {
  const path = changedPath(item);
  switch (item.kind) {
    case "json":
      return ["json", path, ...item.keyPath].join("\n");
    case "json-item":
      return ["json-item", path, ...item.keyPath, item.value].join("\n");
    case "toml":
      return ["toml", path, ...item.table].join("\n");
    case "file":
    case "written-by":
      return `file\n${path}`;
    case "link":
      return `link\n${path}`;
    case "folder":
      return `folder\n${path}`;
    case "line":
      return `line\n${path}\n${item.line}`;
    case "path":
      return `path\n${item.folder.replace(/\\+$/, "").toLowerCase()}`;
  }
}

/** The file `path` really is, through any symbolic links in it, as far as it exists. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/** The person's own PATH as the registry keeps it, unexpanded; null when they have none. */
function readPath(): string | null {
  try {
    return readUserVariable(PATH_VARIABLE)?.value ?? null;
  } catch (err) {
    throw new EditRefused(`Your PATH cannot be read: ${(err as Error).message}`);
  }
}

/** The text of a file, or null when there is none. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new EditRefused(`${path} cannot be read: ${(err as Error).message}`);
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Not a link: what it holds stands in, so a plan sees it as something other than the target.
    return readText(path);
  }
}

/** Refuses `path` when it is a link to nothing: written through, the file would appear where no plan shows it. */
function refuseDanglingLink(path: string) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return;
    realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !lstatSync(path, { throwIfNoEntry: false })) return;
    throw new EditRefused(
      `${path} is a link to ${readlinkSync(path)}, which is not there: the app does not write through it.`,
    );
  }
}

/** A JSON or JSONC file's value; an empty file has none (undefined). */
function readJson(text: string, path: string): unknown {
  if (text.trim() === "") return undefined;
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new EditRefused(`${path} is not valid JSON, so the app does not change it.`);
  return value;
}

function readToml(text: string, path: string): unknown {
  try {
    return parseToml(text);
  } catch {
    throw new EditRefused(`${path} is not valid TOML, so the app does not change it.`);
  }
}

/** The value at `keyPath` in `root`, and how many keys of the path are there (all of them when the value is). */
function lookUp(root: unknown, keyPath: string[]): { value: unknown; existed: number } {
  let value = root;
  for (let i = 0; i < keyPath.length; i++) {
    const key = keyPath[i] ?? "";
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key))
      return { value: undefined, existed: i };
    value = (value as Record<string, unknown>)[key];
  }
  return { value, existed: keyPath.length };
}

function nest(keyPath: string[], leaf: unknown): Record<string, unknown> {
  return keyPath.reduceRight<Record<string, unknown>>(
    (inner, key) => ({ [key]: inner }),
    leaf as Record<string, unknown>,
  );
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

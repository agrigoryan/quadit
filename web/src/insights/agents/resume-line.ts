// The command a person pastes in a terminal to go on with a run's program
// session on their own computer: change to the run's folder, then resume the
// session there. The server only relays the folder's label and the session
// id the runner sent, so the command is built from them only when each has
// its strict form, and the folder is quoted so that nothing in its label is
// ever read by the shell as anything but a name.

import type { AgentSession } from "@/types/core";

/** A canonical UUID: lower-case hex, 8-4-4-4-12. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A folder label: from ~ or /, components of no slash and no control character, none empty. */
// oxlint-disable-next-line no-control-regex -- control characters are what the form refuses
const FOLDER = /^(~|\/)(\/?[^/\x00-\x1f]+)*$/;

/** How each program resumes a session, given its id. */
const resume = new Map<string, (id: string) => string>([
  ["claude", (id) => `claude --resume ${id}`],
  ["codex", (id) => `codex resume ${id}`],
]);

/** One shell word that is exactly `text`: single-quoted, each ' written '\''. */
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A folder label as a shell word for `cd`: a leading `~/` stays unquoted so
 * the shell finds the home folder (`~` alone is `~`), the rest is one
 * single-quoted word. Null when the label is not of the strict form.
 */
export function shellFolder(label: string): string | null {
  if (!FOLDER.test(label)) return null;
  if (label === "~") return "~";
  if (label.startsWith("~/")) return `~/${quoted(label.slice(2))}`;
  return quoted(label);
}

/**
 * The line that resumes a run's program session in its folder, or null
 * when the run lacks a session id or folder of the strict form, or ran a
 * program this page does not know: then no command is shown at all.
 */
export function resumeLine(run: Pick<AgentSession, "program" | "program_session" | "folder">): string | null {
  const command = resume.get(run.program ?? "");
  const session = run.program_session ?? "";
  const folder = shellFolder(run.folder ?? "");
  if (!command || !UUID.test(session) || folder === null) return null;
  return `cd ${folder} && ${command(session)}`;
}

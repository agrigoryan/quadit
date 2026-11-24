// The command a person pastes in a terminal to go on with a run's program
// session on their own computer: change to the run's folder, then resume the
// session there. The server only relays the folder's label and the session
// id the runner sent, so the command is built from them only when each has
// its strict form, and the folder is quoted so that nothing in its label is
// ever read by the shell as anything but a name.

import type { AgentSession } from "@/types/core";

/** A canonical UUID: lower-case hex, 8-4-4-4-12. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A character a label may not hold: a backslash (some shells read it even inside single quotes) or a control character. */
const UNSAFE = /[\\\p{Cc}]/u;

/**
 * Whether a folder label has the strict form: `/`, `~`, or non-empty
 * components under `/` or `~/`, none holding a backslash or a control
 * character. Checked part by part, in time linear in its length.
 */
function strictFolder(label: string): boolean {
  if (label === "/" || label === "~") return true;
  const under = label.startsWith("~/") ? label.slice(2) : label.startsWith("/") ? label.slice(1) : null;
  return under !== null && !UNSAFE.test(under) && under.split("/").every((part) => part !== "");
}

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
  if (!strictFolder(label)) return null;
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

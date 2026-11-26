// The command a person pastes in a terminal to go on with a run's program
// session on their own computer: change to the run's folder, then resume the
// session there. The server only relays the folder's label and the session
// id the runner sent, so the command is built from them only when each has
// its strict form, and the folder is quoted so that nothing in its label is
// ever read by the shell as anything but a name.
//
// A label says which system the run was on by its shape: `~/…` or `/…` is
// macOS or Linux, and the line is for a POSIX shell; `~\…`, a drive (`D:\…`)
// or a network share (`\\server\share\…`) is Windows, and the line is for
// PowerShell (Windows PowerShell 5 as well as 7, which is why it does not use
// `&&`).

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

/**
 * A character a Windows folder label may not hold: one no Windows name has
 * (`<>:"|?*`), a control character, or a quote PowerShell reads as a single
 * quote besides `'` itself (‘ ’ ‚ ‛), which the quoting below does not double.
 */
const WINDOWS_UNSAFE = /[<>:"|?*\u2018\u2019\u201A\u201B\p{Cc}]/u;

/** Whether every part of `path`, parted at backslashes, is a name: none empty, none unsafe. */
function windowsNames(path: string): boolean {
  return path.split("\\").every((part) => part !== "" && !WINDOWS_UNSAFE.test(part));
}

/** One PowerShell word that is exactly `text`: single-quoted, each ' doubled. */
const psQuoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * A Windows folder label as what PowerShell's Set-Location -LiteralPath
 * takes: under the home folder (`~\…`) the rest joined to $HOME, else the
 * label itself (a drive's `D:\…`, or `\\server\share\…`), quoted. Null when
 * the label is not of one of those forms.
 */
export function powershellFolder(label: string): string | null {
  if (label.startsWith("~\\")) {
    const rest = label.slice(2);
    return windowsNames(rest) ? `(Join-Path $HOME ${psQuoted(rest)})` : null;
  }
  const drive = /^[A-Za-z]:\\/.exec(label);
  if (drive) {
    const rest = label.slice(drive[0].length);
    return rest === "" || windowsNames(rest) ? psQuoted(label) : null;
  }
  if (label.startsWith("\\\\")) {
    // A share is a server and a share name at least.
    const rest = label.slice(2);
    return rest.split("\\").length >= 2 && windowsNames(rest) ? psQuoted(label) : null;
  }
  return null;
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
  if (!command || !UUID.test(session)) return null;
  const folder = shellFolder(run.folder ?? "");
  if (folder !== null) return `cd ${folder} && ${command(session)}`;
  const windows = powershellFolder(run.folder ?? "");
  // Set-Location's own error stops it: the program is started only in the run's folder.
  if (windows !== null) return `Set-Location -LiteralPath ${windows}; if ($?) { ${command(session)} }`;
  return null;
}

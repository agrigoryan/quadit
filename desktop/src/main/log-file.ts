// The app's logs of the programs it starts (a tool run to give its code back,
// quadit run): one line at a time, with the time in front, only the person's
// to read, and a new file past a size, the one before kept beside it.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

/** Appends `line` to the log `file`, making its folder when missing. */
export function appendLog(file: string, line: string) {
  mkdirSync(dirname(file), { recursive: true });
  if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`);
  // What a program was asked and said is the person's: theirs alone to read.
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

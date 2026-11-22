// Where a tool's program is, for the app to run it once (self-runs.ts): its
// command on the login shell's PATH, else the copy its desktop app carries
// (harnesses.ts, appCopies), the newest when there are several. Only a
// regular, executable file counts; a link that leads nowhere does not.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@/main/harnesses";

/**
 * The program to run for `harness`, or null: none found, or the tool has no
 * one-prompt command the app could run. `path` is the login shell's PATH;
 * `applications` the folders apps are installed in.
 */
export function toolProgram(
  harness: Pick<Harness, "command" | "oneShot" | "appCopies">,
  where: { home: string; path: string[]; applications: string[] },
): string | null {
  if (!harness.oneShot) return null;
  for (const dir of where.path) {
    const candidate = join(dir, harness.command);
    if (runnable(candidate)) return candidate;
  }
  const copies = (harness.appCopies ?? []).flatMap((copy) => [
    ...(copy.home ? expand(where.home, copy.home) : []),
    ...(copy.apps ? where.applications.flatMap((apps) => expand(apps, copy.apps ?? "")) : []),
  ]);
  const found = copies.filter(runnable).map((path) => ({ path, at: statSync(path).mtimeMs }));
  found.sort((a, b) => b.at - a.at);
  return found[0]?.path ?? null;
}

/** The paths `pattern` names under `base`, each `*` any one folder's name there. */
function expand(base: string, pattern: string): string[] {
  let paths = [base];
  for (const part of pattern.split("/")) {
    paths = paths.flatMap((path) => (part === "*" ? listed(path).map((name) => join(path, name)) : [join(path, part)]));
  }
  return paths;
}

function listed(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Whether `path` is a regular file its owner may run (a link counts by what it leads to). */
function runnable(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  return !!stat && stat.isFile() && (stat.mode & 0o111) !== 0;
}

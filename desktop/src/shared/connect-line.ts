// The line that proves a tool connected (desktop contract §11): said in the
// tool, its agent gives the connect code back to the workspace that made it.
// It names that workspace (multi-workspace design §3.6), so an agent that
// works in several gives it to that one alone, never trying it elsewhere.
// The card shows it to paste; the app runs a tool with it (self-runs.ts).

/** The line for the connect code `code` of the workspace named `workspace`. */
export function connectLine(code: string, workspace: string): string {
  return workspace ? `Connect to Quadit ${code} in ${workspace}` : `Connect to Quadit ${code}`;
}

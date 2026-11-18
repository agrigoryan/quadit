// What the global set-up makes once and every test uses.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/** The server binary `make build` makes in the repository root, with the web app inside. */
export const BINARY = join(__dirname, "../../../bin/quadit");

/** The owner the first-run API makes, and their workspace (its address is /e2e). */
export const OWNER = { name: "Ann Owner", email: "ann@example.com", password: "correct-horse-battery" };
export const WORKSPACE = { name: "E2E", slug: "e2e" };

export interface Run {
  /** The server the app adds: the real server, or with QUADIT_DESKTOP_HANDOFF_STANDIN=1 the hand-off stand-in in front of it. */
  server: string;
  /** The real server, at its own address. */
  direct: string;
  /** Another address of the same server (the one of direct and the stand-in that is not `server`): a second server, as the app sees it. */
  other: string;
  /** The hand-off stand-in (handoff-fake.ts), whose /__fake/log the tests read. */
  fake: string;
  /** The owner's API token, for the CLI. */
  token: string;
  /** The owner's session cookie, made by the first run. */
  session: { name: string; value: string };
  dir: string;
  binary: string;
}

export function currentRun(): Run {
  const raw = process.env.QUADIT_DESKTOP_E2E;
  if (!raw) throw new Error("QUADIT_DESKTOP_E2E is not set: run the suite with `pnpm e2e`, which starts the server.");
  return JSON.parse(raw) as Run;
}

const exec = promisify(execFile);

/** Runs `quadit ARGS…` as the owner against the run's server and gives what it printed. */
export async function quadit(run: Run, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(run.binary, args, {
      env: {
        PATH: process.env.PATH ?? "",
        QUADIT_URL: run.direct,
        QUADIT_TOKEN: run.token,
        QUADIT_CONFIG: join(run.dir, "cli.json"),
      },
    });
    return stdout;
  } catch (err) {
    const { stderr, stdout } = err as { stderr?: string; stdout?: string };
    throw new Error(`quadit ${args.join(" ")}: ${stderr || stdout || String(err)}`, { cause: err });
  }
}

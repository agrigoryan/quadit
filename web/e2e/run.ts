// What the global set-up makes once and every test uses: where the server
// is, the people it made, and how to reach it as them.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The binary `make build` makes, with the web app inside. */
export const BINARY = fileURLToPath(new URL("../../bin/quadit", import.meta.url));

/** The person the first-run page makes. Their handle comes from the name. */
export const OWNER = {
  name: "Ann Owner",
  handle: "ann-owner",
  email: "ann@example.com",
  password: "correct-horse-battery",
};

/** The workspace the first-run page makes; its address is /e2e. */
export const WORKSPACE = { name: "E2E", slug: "e2e" };

/** An agent member, made after the owner, with a token of its own. */
export const AGENT = { name: "Coder", handle: "coder" };

export interface Run {
  /** The server's address, http://127.0.0.1:PORT. */
  url: string;
  /** API tokens of the owner and of the agent, for the CLI. */
  token: string;
  agentToken: string;
  /** The owner's signed-in browser state. */
  storageState: string;
  /** The run's temporary directory (data, CLI config, browser state). */
  dir: string;
}

/**
 * The headers a browser adds to a write made from one of the server's own pages. Playwright's request API
 * carries the page's cookie but no Origin, and the server refuses a write with the cookie that does not say
 * which page it comes from.
 */
export function fromOwnPage(url: string) {
  return { Origin: url };
}

/** The run the global set-up started; it is handed down in QUADIT_E2E. */
export function currentRun(): Run {
  const raw = process.env.QUADIT_E2E;
  if (!raw) throw new Error("QUADIT_E2E is not set: run the suite with `pnpm e2e`, which starts the server.");
  return JSON.parse(raw) as Run;
}

const exec = promisify(execFile);

/** Runs `quadit ARGS…` against the run's server with a token, and gives what it printed; a refusal throws with the CLI's message. */
export async function quadit(run: Pick<Run, "url" | "dir">, token: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(BINARY, args, {
      // Only this run's server: never a saved login from the machine.
      env: {
        PATH: process.env.PATH ?? "",
        QUADIT_URL: run.url,
        QUADIT_TOKEN: token,
        QUADIT_CONFIG: join(run.dir, "cli.json"),
      },
    });
    return stdout;
  } catch (err) {
    const { stderr, stdout } = err as { stderr?: string; stdout?: string };
    throw new Error(`quadit ${args.join(" ")}: ${stderr || stdout || String(err)}`, { cause: err });
  }
}

// The quadit command as Connect uses it: found on the PATH of the person's
// login shell (where the harnesses that run it look), or the app's own copy
// (bundled in its resources) linked into the first folder on that PATH the
// person may write to. The app runs only `quadit version`, `quadit skill`,
// `quadit me`, `quadit login --path` and `quadit login URL -` with the
// token on standard input, so that it never shows on a command line.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const RUN_TIMEOUT_MS = 20_000;

export interface CliLook {
  /** The login shell's PATH, folder by folder. */
  path: string[];
  /** The quadit command on it, and what `quadit version` says. */
  found: { path: string; version: string } | null;
  /** Without one: the first folder on PATH the person may write to, where the app's copy can be linked. */
  linkInto: string | null;
}

export class QuaditCli {
  /**
   * `bundled` is the app's own copy, null when this build has none (run from
   * source); `shellPath` gives the login shell's PATH.
   */
  constructor(
    readonly bundled: string | null,
    private shellPath: () => Promise<string>,
  ) {}

  /** Looks at the login shell's PATH for the quadit command and for a place to link one. */
  async look(): Promise<CliLook> {
    const path = (await this.shellPath()).split(":").filter((dir) => isAbsolute(dir));
    const binary = findCommand("quadit", path);
    if (binary) return { path, found: { path: binary, version: await this.version(binary) }, linkInto: null };
    return { path, found: null, linkInto: path.find(writableFolder) ?? null };
  }

  /** The file `quadit login` saves to by default (without QUADIT_CONFIG). */
  async defaultConfig(binary: string): Promise<string> {
    return (await run(binary, ["login", "--path"], { QUADIT_CONFIG: undefined })).trim();
  }

  /** The skill the command carries. */
  skill(binary: string): Promise<string> {
    return run(binary, ["skill"]);
  }

  /** Who the login saved in `config` is: asks its server (`quadit me`), whatever the app's environment says. */
  async whoIs(binary: string, config: string): Promise<{ id: string; handle: string; name: string }> {
    const said = await run(binary, ["--json", "me"], {
      QUADIT_CONFIG: config,
      QUADIT_URL: undefined,
      QUADIT_TOKEN: undefined,
    });
    const me = JSON.parse(said) as { user_id?: unknown; handle?: unknown; name?: unknown };
    if (typeof me.user_id !== "string" || typeof me.handle !== "string")
      throw new Error("quadit me: no identity in its answer");
    return { id: me.user_id, handle: me.handle.replace(/^@/, ""), name: typeof me.name === "string" ? me.name : "" };
  }

  /** Checks `token` against the server at `origin` and saves both to `config`. */
  async login(binary: string, origin: string, token: string, config: string): Promise<void> {
    await run(binary, ["login", origin, "-"], { QUADIT_CONFIG: config }, token);
  }

  private async version(binary: string): Promise<string> {
    const said = await run(binary, ["version"]).catch(() => "");
    return said.split(/\s+/)[1] ?? "";
  }
}

/** The first `name` on `path` that is an executable file, or null. */
export function findCommand(name: string, path: string[]): string | null {
  for (const dir of path) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

function writableFolder(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `binary args` with `env` over the app's environment (undefined removes a variable); gives its output. */
function run(
  binary: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<string> {
  const merged = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete merged[key];
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { env: merged, timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(`quadit ${args[0]}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
    // A quadit that stops before reading its input (a usage error, an older
    // one) breaks the pipe: its exit code and its words say what happened.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
  });
}

/**
 * The PATH of the person's login shell: what a harness started from a
 * terminal sees. An app started from the Dock has a much shorter one. Asked
 * once per look, of an interactive login shell (where most people set PATH).
 */
export function loginShellPath(): Promise<string> {
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", "env"], { timeout: RUN_TIMEOUT_MS }, (err, stdout) => {
      const line = stdout.split("\n").find((l) => l.startsWith("PATH="));
      resolve(!err && line ? line.slice("PATH=".length) : (process.env.PATH ?? ""));
    });
  });
}

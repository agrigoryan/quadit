// The quadit command as Connect uses it: found on the PATH of the person's
// login shell (where the harnesses that run it look), or the app's own copy
// (bundled in its resources) linked into the first folder on that PATH the
// person may write to; without one, into a folder of their own,
// ~/.local/bin, which one marked line in the profile their login shell
// reads puts on the PATH. Windows has no login shell, and a link there
// needs a privilege: its PATH is the one the registry gives a program
// started now (windows-environment.ts), and the folder the app's quadit.exe
// is in is added to the person's own PATH. No step needs an administrator.
// The app runs only `quadit version`, `quadit skill`,
// `quadit me`, `quadit login --path` and `quadit login URL -` (with
// `--app PATH` for its own server's logins) with the token on standard
// input, so that it never shows on a command line.

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { withoutQuadit } from "@/main/child-guard";
import { systemPath } from "@/main/windows-environment";

const RUN_TIMEOUT_MS = 20_000;

export interface CliLook {
  /** The login shell's PATH, folder by folder. */
  path: string[];
  /** The quadit command on it, and what `quadit version` says. */
  found: { path: string; version: string } | null;
  /** Without one, how the app's copy can be put on the PATH (Install); null where it cannot be. */
  install: Install | null;
}

/**
 * How the app's copy of quadit is put on the PATH. "link": linked into
 * `folder`, the first folder on PATH the person may write to, else
 * ~/.local/bin, made when missing, with the line that puts it on the PATH
 * in the login shell's profile (`profile`, null when it is on the PATH
 * already). "path" (Windows): `folder`, where the app's quadit.exe is, added
 * to the person's PATH.
 */
export type Install =
  { way: "link"; folder: string; profile: { path: string; line: string } | null } | { way: "path"; folder: string };

/** Where the person's own commands go, under their home folder (the XDG convention). */
const OWN_BIN = [".local", "bin"];
const MARK = "# Added by the Quadit app: Disconnect in the app takes it out.";

export class QuaditCli {
  /** The link the app made this session: found even where the login PATH the app sees does not show it yet. */
  private linkedNow: string | null = null;

  /**
   * `bundled` is the app's own copy, null when this build has none (run from
   * source); `shellPath` gives the login shell's PATH; `home` and `shell`
   * (its path, as $SHELL says) are where the app's copy goes without a
   * folder on the PATH to write to; `platform` how paths are written and
   * programs found.
   */
  constructor(
    readonly bundled: string | null,
    private shellPath: () => Promise<string>,
    private where: { home: string; shell: string; platform: NodeJS.Platform },
  ) {}

  /** Looks at the login shell's PATH for the quadit command and for a way to put one there. */
  async look(): Promise<CliLook> {
    const { platform } = this.where;
    const paths = platform === "win32" ? win32 : posix;
    const path = (await this.shellPath()).split(paths.delimiter).filter((dir) => paths.isAbsolute(dir));
    const binary =
      findCommand("quadit", path, platform) ??
      (this.linkedNow && findCommand("quadit", [paths.dirname(this.linkedNow)], platform));
    if (binary) return { path, found: { path: binary, version: await this.version(binary) }, install: null };
    return { path, found: null, install: this.install(path) };
  }

  /** The app put its copy on the PATH at `link`: this session's calls use it (look finds it), whatever the PATH the app sees says. */
  linked(link: string) {
    this.linkedNow = link;
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
  /**
   * `quadit login ORIGIN -` into `config`, the token on standard input.
   * `app` (the running app's executable) marks a login for the server the
   * app runs on this computer, so that the command may start the app when
   * that server is not running (desktop contract §11, amendment); null for
   * any other server, whose login carries no mark. A quadit too old to know
   * the mark logs in without it: no start on demand for that login, rather
   * than no login.
   */
  async login(binary: string, origin: string, token: string, config: string, app: string | null): Promise<void> {
    const env = { QUADIT_CONFIG: config };
    if (app) {
      const marked = await run(binary, ["login", origin, "-", "--app", app], env, token).then(
        () => true,
        () => false,
      );
      if (marked) return;
    }
    await run(binary, ["login", origin, "-"], env, token);
  }

  private install(path: string[]): Install | null {
    if (this.where.platform === "win32")
      return this.bundled ? { way: "path", folder: win32.dirname(this.bundled) } : null;
    const onPath = path.find(writableFolder);
    if (onPath) return { way: "link", folder: onPath, profile: null };
    const { home, shell } = this.where;
    const own = posix.join(home, ...OWN_BIN);
    // On the PATH already, but not there yet (Linux distributions add it at login when it exists): made, it is enough.
    if (path.includes(own)) return { way: "link", folder: own, profile: null };
    const profile = loginProfile(home, shell);
    return profile ? { way: "link", folder: own, profile } : null;
  }

  private async version(binary: string): Promise<string> {
    const said = await run(binary, ["version"]).catch(() => "");
    return said.split(/\s+/)[1] ?? "";
  }
}

/**
 * The program `name` stands for on `path`, as `platform` finds it: the first
 * folder that has it. On Windows a program is a file with one of the
 * extensions PATHEXT lists, tried in its order in each folder (quadit is
 * quadit.exe there); elsewhere a file its owner may run. Null without one.
 */
export function findCommand(name: string, path: string[], platform: NodeJS.Platform): string | null {
  const windows = platform === "win32";
  const names = windows ? programExtensions().map((extension) => name + extension) : [name];
  for (const dir of path) {
    for (const file of names) {
      const candidate = join(dir, file);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** The extensions of programs on Windows, in the order Windows tries them (PATHEXT), written lower-case. */
function programExtensions(): string[] {
  const listed = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.startsWith("."));
  return listed.map((extension) => extension.toLowerCase());
}

/**
 * The profile `shell` reads at login, and the marked line that puts
 * ~/.local/bin on the PATH there: zsh ~/.zprofile; bash ~/.bash_profile
 * when there is one, else ~/.profile; fish a file of its own in conf.d.
 * Null for another shell.
 */
function loginProfile(home: string, shell: string): { path: string; line: string } | null {
  const sh = `export PATH="$HOME/${OWN_BIN.join("/")}:$PATH" ${MARK}`;
  switch (posix.basename(shell)) {
    case "zsh":
      return { path: posix.join(home, ".zprofile"), line: sh };
    case "bash": {
      const bashProfile = posix.join(home, ".bash_profile");
      return { path: existsSync(bashProfile) ? bashProfile : posix.join(home, ".profile"), line: sh };
    }
    case "fish":
      return {
        path: posix.join(home, ".config", "fish", "conf.d", "quadit.fish"),
        line: `fish_add_path --global --path $HOME/${OWN_BIN.join("/")} ${MARK}`,
      };
    default:
      return null;
  }
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

/**
 * Runs `binary args` with `env` over the app's environment (undefined removes
 * a variable); gives its output. None of the app's own QUADIT_ settings (the
 * person's own servers' address and token) reach it: only those given here.
 */
function run(
  binary: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<string> {
  const merged = { ...withoutQuadit(process.env), ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete merged[key];
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { env: merged, timeout: RUN_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`quadit ${args[0]}: ${(stderr || stdout || err.message).trim()}`));
        else resolve(stdout);
      },
    );
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
 * On Windows, the PATH the registry gives a program started now: the app's
 * own is the one it was started with, which a change since does not reach.
 */
export function loginShellPath(): Promise<string> {
  if (process.platform === "win32") return systemPath();
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", "env"], { timeout: RUN_TIMEOUT_MS }, (err, stdout) => {
      const line = stdout.split("\n").find((l) => l.startsWith("PATH="));
      resolve(!err && line ? line.slice("PATH=".length) : (process.env.PATH ?? ""));
    });
  });
}

// The app on Windows, end to end (the Windows contract): set up on this
// computer, Connect with a stand-in Claude Code, and a run Quadit starts
// with it. Runs on Windows only (desktop-ci's e2e-windows job), on a
// computer of the test's own: a home folder (USERPROFILE, and APPDATA, where
// quadit keeps its logins and its runner's registry there) and the
// stand-ins first on the person's PATH in the registry, which is where the
// app reads the PATH on Windows (put back as it was after each test).
//
// Two stand-ins play Claude Code:
//   - internal/fakeagent, the command's test binary (go test -c
//     ./internal/cli, as bin/fake-claude.exe), which is the agent program
//     when FAKEAGENT says which, for a run Quadit starts. Told "Connect to
//     Quadit CODE" it gives nothing back: there the card falls back to the
//     line to paste, and the test gives the code back with quadit connect.
//   - claude.cmd (GIVES_CODE_BACK below), as npm installs a program: told
//     `-p "Connect to Quadit CODE in WORKSPACE"`, it runs `quadit connect CODE`, finding
//     quadit on the PATH it was given, as Claude Code does, and notes what
//     it did (STANDIN_RECORD). The guard starts a .cmd through cmd.exe.
//
// What the app holds besides its server (the run giving a code back, quadit
// run) starts under quadit guard there.

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { readUserVariable, systemPath, writeUserVariable } from "../../src/main/windows-environment";
import { Desktop, expect, screen, test } from "./desktop";
import { bareEnv, type Run } from "./run";

test.skip(process.platform !== "win32", "the app on Windows");

/** The stand-in agent program: the command's test binary, built by desktop-ci (go test -c -o bin/fake-claude.exe ./internal/cli). */
const FAKE_AGENT = join(__dirname, "../../../bin/fake-claude.exe");

/** What the stand-in Claude Code does when Quadit runs it for a task: starts, says a word, and ends well with its final message. */
const CLAUDE_DONE = [
  { out: JSON.stringify({ type: "system", subtype: "init", session_id: "{session}", cwd: "C:\\x", tools: ["Bash"] }) },
  {
    out: JSON.stringify({
      type: "assistant",
      session_id: "{session}",
      message: { content: [{ type: "text", text: "On it." }] },
    }),
  },
  {
    out: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Added the line.",
      session_id: "{session}",
    }),
  },
];

/**
 * The stand-in Claude Code that gives its code back, a .cmd: the code is the
 * fourth word of the prompt, its second argument. It notes its start, where
 * it finds quadit, and what quadit connect said, in STANDIN_RECORD.
 */
const GIVES_CODE_BACK = [
  "@echo off",
  "setlocal",
  '>>"%STANDIN_RECORD%" echo started: %*',
  'for /f "tokens=4" %%c in ("%~2") do set code=%%c',
  "if not defined code exit /b 3",
  '>>"%STANDIN_RECORD%" where quadit 2>&1',
  '>>"%STANDIN_RECORD%" quadit connect %code% 2>&1',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

/**
 * A computer of the test's own: a home folder, and a folder first on the
 * person's PATH with, unless `quadit` is false, a quadit.exe (the run's own);
 * with `claude`, Claude Code's settings folder and a stand-in claude.exe
 * there ("fake-agent" or "gives-code-back", above). Gives the app's
 * environment, where quadit keeps its logins, the stand-in's record of its
 * starts, the PATH the test set, and the way to put the PATH back.
 */
function windowsComputer(
  run: Run,
  { claude, quadit = true }: { claude: "none" | "fake-agent" | "gives-code-back"; quadit?: boolean },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quadit-desktop-windows-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const appData = join(home, "AppData", "Roaming");
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(home, "AppData", "Local"), { recursive: true });
  mkdirSync(bin);
  if (quadit) copyFileSync(run.binary, join(bin, "quadit.exe"));
  const scripts = join(root, "scripts.json");
  const record = join(root, "record.jsonl");
  writeFileSync(scripts, JSON.stringify([CLAUDE_DONE]));
  const standIn = join(root, "stand-in.log");
  if (claude !== "none") {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  }
  if (claude === "fake-agent") copyFileSync(FAKE_AGENT, join(bin, "claude.exe"));
  if (claude === "gives-code-back") writeFileSync(join(bin, "claude.cmd"), GIVES_CODE_BACK);
  const before = readUserVariable("Path");
  // Without a closing ";" (Windows' own default ends with one): Connect's folder then comes after one it adds, and
  // Disconnect gives back exactly this.
  const path = [bin, before?.value ?? ""].join(";").replace(/;+$/, "");
  writeUserVariable("Path", { value: path, expand: before?.expand ?? true });
  const places = { USERPROFILE: home, HOME: home, APPDATA: appData, LOCALAPPDATA: join(home, "AppData", "Local") };
  // Where quadit keeps its logins and its runner's registry there: the command says, never the test.
  const login = execFileSync(run.binary, ["login", "--path"], { env: { ...bareEnv(), ...places }, encoding: "utf8" });
  return {
    home,
    configDir: dirname(login.trim()),
    record,
    standIn,
    path,
    env: {
      ...places,
      QUADIT_DESKTOP_QUADIT: run.binary,
      FAKEAGENT: "claude",
      FAKEAGENT_SCRIPTS: scripts,
      FAKEAGENT_RECORD: record,
      STANDIN_RECORD: standIn,
    },
    restore: () => writeUserVariable("Path", before),
  };
}

/** Whether a Quadit server answers at `origin`. */
async function answers(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/readyz`)).ok;
  } catch {
    return false;
  }
}

/** Runs the run's quadit as the login at `config`, as the agent in its tool would. */
function asTheAgent(run: Run, config: string, args: string[]) {
  return promisify(execFile)(run.binary, args, { env: { ...bareEnv(), QUADIT_CONFIG: config } });
}

/**
 * The first run, from its first page: set up on this computer as Lou Local,
 * and Claude Code connected on its card: "by-hand", the code given back by
 * the test when the card asks for it; "by-itself", by the app's own run of
 * the stand-in; then Continue. Gives the server's address and its window.
 */
async function firstRun(
  desktop: Desktop,
  run: Run,
  computer: ReturnType<typeof windowsComputer>,
  connect: "none" | "by-hand" | "by-itself",
): Promise<{ origin: string; page: Page }> {
  const first = await desktop.firstRun();
  await first.getByLabel("Your name").fill("Lou Local");
  await first.getByRole("button", { name: "Set up on this computer" }).click();
  if (connect === "by-itself") {
    const card = first.getByRole("article", { name: "Claude Code" });
    await card.getByRole("button", { name: "Connect Claude Code" }).click({ timeout: 90_000 });
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 90_000 });
  }
  if (connect === "by-hand") {
    const card = first.getByRole("article", { name: "Claude Code" });
    await card.getByRole("button", { name: "Connect Claude Code" }).click({ timeout: 90_000 });
    const line = card.getByText(/^Connect to Quadit \S{6} in \S.*$/);
    await expect(line).toBeVisible({ timeout: 60_000 });
    await screen(first, "windows-01-first-run-waiting.png");
    const code = (await line.innerText()).split(" ")[3] ?? "";
    await asTheAgent(run, join(computer.configDir, "claude.json"), ["connect", code]);
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
  }
  // Its first start on a fresh data folder, which Windows may scan first, can take a while.
  await first.getByRole("button", { name: "Continue" }).click({ timeout: 90_000 });
  await expect.poll(() => desktop.firstRunShown(), { timeout: 20_000 }).toBe(false);
  const origin = await desktop.localOrigin();
  const page = await desktop.pageOf(origin);
  await expect(page.getByText("Three sample tasks to try Quadit with.")).toBeVisible({ timeout: 30_000 });
  return { origin, page };
}

test("set up on this computer, the app runs quadit.exe as its server, signs its window in, and quitting stops it", async ({
  run,
}) => {
  const computer = windowsComputer(run, { claude: "none" });
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let origin = "";
  try {
    const desktop = await Desktop.launch(data, run, [], { env: computer.env, firstStart: true });
    try {
      let page: Page;
      ({ origin, page } = await firstRun(desktop, run, computer, "none"));
      expect(await answers(origin)).toBe(true);
      expect(existsSync(join(data, "server", "quadit.sqlite"))).toBe(true);
      expect(await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status)).toBe(200);
      await screen(page, "windows-02-workspace.png");
    } finally {
      await desktop.close();
    }
    // Quitting closed the server's input: it stops on its own, a moment later.
    expect(origin).not.toBe("");
    await expect.poll(() => answers(origin), { timeout: 15_000 }).toBe(false);
  } finally {
    computer.restore();
  }
});

test("Connect sets a stand-in Claude Code up with Windows paths, it gives its code back, and Disconnect takes it all back", async ({
  run,
}) => {
  test.setTimeout(300_000);
  const computer = windowsComputer(run, { claude: "fake-agent" });
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  try {
    const desktop = await Desktop.launch(data, run, [], { env: computer.env, firstStart: true });
    try {
      await firstRun(desktop, run, computer, "by-hand");
      const settings = join(computer.home, ".claude", "settings.json");
      const login = join(computer.configDir, "claude.json");
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
        permissions: { allow: ["Read", "Bash(quadit:*)", "PowerShell(quadit *)"] },
        env: { QUADIT_CONFIG: login },
      });
      expect(existsSync(join(computer.home, ".claude", "skills", "quadit", "SKILL.md"))).toBe(true);
      // The quadit.exe on the PATH was found: the person's PATH is as the test left it.
      expect(readUserVariable("Path")?.value).toBe(computer.path);

      await desktop.chooseMenuItem("connect");
      const connect = await desktop.appPage("connect.html");
      const card = connect.getByRole("article", { name: "Claude Code" });
      await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
      await screen(connect, "windows-03-connect-connected.png");
      await card.getByRole("button", { name: "Disconnect Claude Code" }).click();
      const undo = connect.getByRole("dialog", { name: "What disconnecting Claude Code changes" });
      await undo.getByRole("button", { name: "Disconnect Claude Code" }).click();
      await expect(connect.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible({ timeout: 70_000 });
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
      expect(existsSync(login)).toBe(false);
      expect(existsSync(join(computer.home, ".claude", "skills", "quadit", "SKILL.md"))).toBe(false);
    } finally {
      await desktop.close();
    }
  } finally {
    computer.restore();
  }
});

test("Run by Quadit starts the stand-in Claude Code for the task waiting on it, in the project's folder, through quadit guard", async ({
  run,
}, testInfo) => {
  test.setTimeout(300_000);
  const computer = windowsComputer(run, { claude: "fake-agent" });
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const folder = testInfo.outputPath("game");
  mkdirSync(folder, { recursive: true });
  const registry = join(computer.configDir, "runner.json");
  const entries = () =>
    existsSync(registry)
      ? (JSON.parse(readFileSync(registry, "utf8")) as { entries: { project: string }[] }).entries
      : [];
  /** The folders the stand-in was started in, as it recorded them. */
  const startedIn = () =>
    existsSync(computer.record)
      ? readFileSync(computer.record, "utf8")
          .trim()
          .split("\n")
          .flatMap((line) => {
            const start = JSON.parse(line) as { dir?: string };
            return start.dir ? [start.dir.toLowerCase()] : [];
          })
      : [];
  try {
    const desktop = await Desktop.launch(data, run, [], { env: computer.env, firstStart: true });
    try {
      // The first run handed GS-3 to Claude Code's agent: it waits on it, so Start running starts it at once.
      const { page } = await firstRun(desktop, run, computer, "by-hand");
      await expect(page.getByText(/is for Claude Code/)).toBeVisible({ timeout: 20_000 });
      await desktop.chooseMenuItem("connect");
      const connect = await desktop.appPage("connect.html");
      const card = connect.getByRole("article", { name: "Claude Code" });
      const offer = card.getByRole("button", { name: "Run Claude Code by Quadit for a project" });
      await offer.click({ timeout: 20_000 });
      await card.getByLabel("Which project?").selectOption("GS");
      await desktop.chooseNextFolder(folder);
      await card.getByRole("button", { name: "Choose folder…" }).click();
      await card.getByRole("button", { name: "Start running" }).click();
      await expect.poll(entries, { timeout: 30_000 }).toEqual([expect.objectContaining({ project: "GS" })]);

      // quadit run, under the guard, starts the stand-in in the folder; it ends well, and its last word is on GS-3.
      await expect.poll(startedIn, { timeout: 90_000 }).toContain(realpathSync(folder).toLowerCase());
      const login = join(computer.configDir, "claude.json");
      await expect
        .poll(async () => (await asTheAgent(run, login, ["--json", "show", "GS-3"])).stdout, { timeout: 60_000 })
        .toContain("Added the line.");
      await expect(card.getByText(/^Ready\.$/)).toBeVisible({ timeout: 30_000 });
      await screen(connect, "windows-04-run-by-quadit-ready.png");

      await card.getByRole("button", { name: /^Stop running GS for @/ }).click();
      await expect.poll(entries, { timeout: 70_000 }).toEqual([]);
    } finally {
      await desktop.close();
    }
  } finally {
    computer.restore();
  }
});

test("the first Connect puts the app's quadit on the person's PATH, the stand-in gives its code back through the guard, Disconnect takes exactly that out, and Connect puts it back", async ({
  run,
}, testInfo) => {
  test.setTimeout(300_000);
  // No quadit on the PATH: the app's own (QUADIT_DESKTOP_QUADIT, run from source) is what Connect puts there.
  const computer = windowsComputer(run, { claude: "gives-code-back", quadit: false });
  const folder = dirname(run.binary);
  const added = `${computer.path};${folder}`;
  /** What each look below saw: the person's PATH as the registry keeps it, the PATH Windows gives, and where's answer. */
  const looks: string[] = [];
  /**
   * Where a program started now with the PATH Windows gives finds quadit
   * (where.exe, as a terminal would: with PATHEXT, without which it looks
   * for a file named quadit alone); "" when nowhere.
   */
  const quaditFound = async () => {
    const where = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
    const path = await systemPath();
    const env = { ...bareEnv(), PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", PATH: path };
    let found = "";
    try {
      found = execFileSync(where, ["quadit"], { env, encoding: "utf8" }).trim().toLowerCase();
    } catch (err) {
      found = "";
      looks.push(`where.exe: ${String((err as { stderr?: unknown }).stderr ?? err).trim()}`);
    }
    looks.push(
      `HKCU Path: ${readUserVariable("Path")?.value ?? "(none)"}`,
      `PATH given: ${path}`,
      `found: ${found}`,
      "",
    );
    return found;
  };
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  try {
    // Before Connect, nothing a new terminal would run is quadit.
    expect(await quaditFound()).toBe("");
    const desktop = await Desktop.launch(data, run, [], { env: computer.env, firstStart: true });
    try {
      // Connected by itself: the app's one-prompt run of the stand-in (a .cmd, which the guard starts through
      // cmd.exe) gave the code back with the quadit it found on the PATH Connect had just added to.
      await firstRun(desktop, run, computer, "by-itself");
      expect(readUserVariable("Path")?.value).toBe(added);
      expect(await quaditFound()).toContain(join(folder, "quadit.exe").toLowerCase());

      await desktop.chooseMenuItem("connect");
      const connect = await desktop.appPage("connect.html");
      const card = connect.getByRole("article", { name: "Claude Code" });
      await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
      await card.getByRole("button", { name: "Disconnect Claude Code" }).click();
      const undo = connect.getByRole("dialog", { name: "What disconnecting Claude Code changes" });
      await expect(undo.getByText("Your PATH", { exact: true })).toBeVisible();
      await undo.getByRole("button", { name: "Disconnect Claude Code" }).click();
      await expect(connect.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible({ timeout: 70_000 });
      expect(readUserVariable("Path")?.value).toBe(computer.path);
      expect(await quaditFound()).toBe("");

      // Again, in the same session: the folder goes back on the PATH.
      await card.getByRole("button", { name: "Connect Claude Code" }).click();
      await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 90_000 });
      expect(readUserVariable("Path")?.value).toBe(added);
      await screen(connect, "windows-05-connected-by-itself.png");
    } finally {
      await desktop.close();
    }
  } finally {
    computer.restore();
    // What shows where a code got lost: the app's log of its runs of the tool (what the guard and the stand-in said),
    // and the stand-in's own notes.
    for (const [name, file] of [
      ["the app's log of its Claude Code runs", join(data, "tools", "logs", "claude.log")],
      ["the stand-in's notes", computer.standIn],
    ] as const)
      if (existsSync(file)) await testInfo.attach(name, { path: file, contentType: "text/plain" });
    // And the person's PATH at each look, before Connect too.
    await testInfo.attach("the PATH at each look", {
      body: [`HKCU Path set by the test: ${computer.path}`, "", ...looks].join("\n"),
      contentType: "text/plain",
    });
  }
});

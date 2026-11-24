// Run by Quadit, end to end (agent-runs-contract.md §8, §11.4): the app set
// up on a computer of the test's own, Claude Code connected by the first
// run (the stand-in gives its code back), then, on its card in Connect
// agents, Quadit runs its agent for the sample project in a folder of the
// test's: the app asks the quadit it carries to add the entry (runner.json
// in the folder of the quadit logins), starts quadit run, and the card says
// Ready once the runner holds the project on the app's own server. Stop
// running takes the entry away. The card's three states are saved as
// pictures in onboarding-screens/ (desktop.ts, SCREENS). It needs a quadit
// with `quadit run` and a server that speaks to it (the runner and server
// parts of the contract), so it runs on CI once those have merged.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, fakeComputer, screen, test } from "./desktop";

test("Run by Quadit runs a connected Claude Code for a project in a folder, the card saying Ready, and Stop running takes it back", async ({
  run,
}, testInfo) => {
  test.slow();
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  const computer = fakeComputer({ quadit: run.binary });
  const env = { QUADIT_DESKTOP_QUADIT: run.binary, HOME: computer.home, SHELL: computer.shell };
  // The project's folder: outside the system's folders (a temporary folder is under /private on macOS, which
  // quadit run refuses), and not the home folder or above it.
  const folder = testInfo.outputPath("game");
  mkdirSync(folder, { recursive: true });
  // Where quadit keeps its registry: the folder of its logins, as the platform the test runs on has it.
  const registry =
    process.platform === "darwin"
      ? join(computer.configDir, "runner.json")
      : join(process.env.XDG_CONFIG_HOME || join(computer.home, ".config"), "quadit", "runner.json");
  const entries = () =>
    existsSync(registry)
      ? (
          JSON.parse(readFileSync(registry, "utf8")) as {
            entries: { project: string; folder: string; program: string }[];
          }
        ).entries
      : [];
  const desktop = await Desktop.launch(data, run, [], { env, firstStart: true });
  try {
    // The first run: set up here, Claude Code connected by itself, then the sample tasks (project GS).
    const first = await desktop.firstRun();
    await first.getByLabel("Your name").fill("Lou Local");
    await first.getByRole("button", { name: "Set up on this computer" }).click();
    const firstCard = first.getByRole("article", { name: "Claude Code" });
    await firstCard.getByRole("button", { name: "Connect Claude Code" }).click({ timeout: 30_000 });
    await expect(firstCard.getByText("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    await first.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => desktop.firstRunShown(), { timeout: 20_000 }).toBe(false);
    const origin = await desktop.localOrigin();
    const page = await desktop.pageOf(origin);
    await expect(page.getByText(/is for Claude Code/)).toBeVisible({ timeout: 20_000 });

    // Connect agents, from the menu: the card offers Run by Quadit.
    await desktop.chooseMenuItem("connect");
    const connect = await desktop.appPage("connect.html");
    const card = connect.getByRole("article", { name: "Claude Code" });
    const offer = card.getByRole("button", { name: "Run Claude Code by Quadit for a project" });
    await expect(offer).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByText(/^Quadit can start Claude Code for you when you assign @\S+ a task or comment on one/),
    ).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await screen(connect, "09-run-by-quadit-offer.png");

    // Choosing, in the card: the project, the folder from the picker, then Start running.
    await offer.click();
    await card.getByLabel("Which project?").selectOption("GS");
    // The first run handed GS-3 to Claude Code's agent: it waits on it, so Start running starts it at once, and the
    // form says so first (quadit run waiting).
    await expect(card.getByText(/^Starts now on GS-3 /)).toBeVisible({ timeout: 20_000 });
    await desktop.chooseNextFolder(folder);
    await card.getByRole("button", { name: "Choose folder…" }).click();
    await expect(card.getByText(/runs there with full access, as you/)).toBeVisible();
    await expect(card.getByText(/Only your words, or those of your other agents, start it\./)).toBeVisible();
    const start = card.getByRole("button", { name: "Start running" });
    await expect(start).toBeEnabled();
    await screen(connect, "10-run-by-quadit-choosing.png");
    await start.click();

    // The entry is the runner's, written by quadit run add; the card says what it runs and, once the runner holds
    // the project, Ready.
    await expect
      .poll(entries, { timeout: 30_000 })
      .toEqual([expect.objectContaining({ project: "GS", folder: realpathSync(folder), program: "claude" })]);
    await expect(card.getByText(/^Runs GS in /)).toBeVisible({ timeout: 20_000 });
    // Ready, or at work on GS-3, which waited (the stand-in Claude Code fails to do it, and the runner tries again).
    await expect(card.getByText(/^(Ready\.|Working on GS-3\.)$/)).toBeVisible({ timeout: 60_000 });
    await screen(connect, "11-run-by-quadit-ready.png");

    // Stop running: the runner lets the project go and the entry is gone; the offer is back.
    await card.getByRole("button", { name: /^Stop running GS for @/ }).click();
    await expect.poll(entries, { timeout: 70_000 }).toEqual([]);
    await expect(offer).toBeVisible({ timeout: 20_000 });
  } finally {
    await desktop.close();
  }
});

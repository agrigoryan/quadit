// Connect agents' page on its own, in a plain headless browser: the built
// page (out/pages/connect.html) with the app's side played by a stand-in of
// its pages API, which the test steers. No app, no server: what is checked
// is that the page changes a card's nodes only when what the card shows
// changes, so that focus, a selection or a click inside it survive an
// answer about where its tool stands and the redraw after a Disconnect; and
// Run by Quadit's states on a connected card (agent-runs-contract.md §8.2).

import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PAGE = `file://${join(__dirname, "../../out/pages/connect.html")}`;

/** What the stand-in answers; the test changes it through `window.stand`. */
interface Stand {
  connected: boolean;
  handshake: unknown;
  /** What the app does by itself for the tool (SelfRun); absent: nothing. */
  self?: unknown;
  /** The last line the page put on the clipboard. */
  copied?: string;
  /** What Quadit runs the tool for (RunsView); absent: Quadit cannot run it. */
  runs?: { agent: string; entries: Record<string, unknown>[] } | null;
  /** What the page asked Quadit to start and stop running. */
  started?: string[][];
  stopped?: string[];
  /** How long connectState takes, as the app's does while it asks the login shell and quadit. */
  slowMs: number;
  asks: number;
  /** How many times the page asked which window it is over: the last step of each of its redraws. */
  targets: number;
}

/** Loads the page over a stand-in where Claude Code is set up (or not) and its state answer is `handshake`. */
async function open(page: Page, stand: Omit<Stand, "asks" | "targets">) {
  await page.addInitScript(
    (initial: Stand) => {
      const state = { ...initial };
      (window as unknown as { stand: Stand }).stand = state;
      const summary = {
        workspace: { id: "w1", slug: "e2e", name: "E2E" },
        me: { name: "Ann", canCreateAgents: true },
        waiting: [],
        agents: [],
        projects: [],
      };
      const plan = {
        id: "p1",
        warnings: [],
        files: [
          { path: "/h/.claude/skills/quadit/SKILL.md", shown: "~/x", role: "skill", change: "removed", diff: "" },
        ],
      };
      const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
      (window as unknown as { quaditPages: unknown }).quaditPages = {
        connectTarget: async () => {
          state.targets++;
          return { serverId: "s1", serverName: "Work", summary, openedByPage: false };
        },
        connectState: async () => {
          await wait(state.slowMs);
          return {
            supported: true,
            defaultLogin: null,
            claudePlugin: false,
            cli: { found: "/usr/local/bin/quadit", version: "9.9.9", linkInto: null, profile: null, manual: null },
            harnesses: [
              {
                id: "claude",
                name: "Claude Code",
                initials: "CC",
                installed: true,
                mcp: true,
                cliIdentity: "own",
                listenVerified: true,
                chatListens: "background",
                allows: true,
                skillChangedByHand: false,
                connected: state.connected
                  ? { methods: ["cli"], server: "Work", workspace: "E2E", agent: "@claude-code" }
                  : null,
              },
            ],
          };
        },
        toolSelf: async () => (state.connected ? (state.self ?? { proving: null }) : null),
        runEntries: async () => state.runs ?? null,
        agentProjects: async () => ({
          ok: true,
          projects: [
            { key: "SVA", name: "Samurai vs Aliens" },
            { key: "GS", name: "Getting started" },
          ],
        }),
        pickFolder: async () => ({ path: "/Users/ann/devel/game", shown: "~/devel/game" }),
        startRunning: async (id: string, project: string, folder: string) => {
          state.started = [...(state.started ?? []), [id, project, folder]];
          const entry = {
            id: "e1",
            project,
            folder: "~/devel/game",
            program: "claude",
            status: { state: "starting" },
            blocked: [],
          };
          state.runs = { agent: state.runs?.agent ?? "", entries: [...(state.runs?.entries ?? []), entry] };
          return { ok: true };
        },
        stopRunning: async (_id: string, entry: string) => {
          state.stopped = [...(state.stopped ?? []), entry];
          if (state.runs) state.runs = { ...state.runs, entries: state.runs.entries.filter((e) => e.id !== entry) };
          return { ok: true };
        },
        showRunnerLog: async () => {},
        toolHandshake: async () => {
          state.asks++;
          return state.connected ? state.handshake : null;
        },
        planDisconnect: async () => ({ ok: true, plan }),
        applyDisconnect: async () => {
          state.connected = false;
          return { ok: true, notes: [], unrevoked: null };
        },
        dropPlan: async () => {},
        copyText: async (text: string) => {
          state.copied = text;
        },
        onChanged() {},
        showBackups: async () => {},
        closeConnect: async () => {},
      };
    },
    { ...stand, asks: 0, targets: 0 },
  );
  await page.goto(PAGE);
}

/** Marks an element, so that the test can tell later whether it is still that one. */
const mark = (page: Page, selector: string, name: string) =>
  page.locator(selector).evaluate((el, n) => el.setAttribute("data-test-mark", n), name);

test("an answer equal to the last changes no node of the card: focus and a selection in it survive", async ({
  page,
}) => {
  await open(page, { connected: true, handshake: { state: "waiting", code: "K7QX4M" }, slowMs: 0 });
  const card = page.getByRole("article", { name: "Claude Code" });
  const copy = card.getByRole("button", { name: "Copy the line to say in Claude Code" });
  await expect(copy).toBeVisible();
  await mark(page, 'article[aria-label="Claude Code"]', "card");
  await mark(page, 'article[aria-label="Claude Code"] .say code', "line");
  await copy.focus();
  await copy.evaluate((el) => el.setAttribute("data-test-mark", "copy"));
  const asks = await page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks);
  // Two more answers, each the same as the last.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(asks + 2);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-test-mark"))).toBe("copy");
  await expect(card.locator('[data-test-mark="line"]')).toHaveText("Connect to Quadit K7QX4M");

  // A selection of the line survives too.
  await page.locator('[data-test-mark="line"]').selectText();
  const selected = await page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(selected + 1);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("Connect to Quadit K7QX4M");

  // An answer that changes what it shows changes the card in place: it is the same card.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = { state: "connected", listening: true };
  });
  await expect(card.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('article[data-test-mark="card"]')).toHaveCount(1);
});

test("the page's redraw after a Disconnect keeps the card and the Connect button it already shows", async ({
  page,
}) => {
  await open(page, { connected: true, handshake: { state: "connected", listening: false }, slowMs: 0 });
  const card = page.getByRole("article", { name: "Claude Code" });
  await mark(page, 'article[aria-label="Claude Code"]', "card");
  // From now on, connectState takes a while, as the app's does.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.slowMs = 800;
  });
  const targets = await page.evaluate(() => (window as unknown as { stand: Stand }).stand.targets);
  await card.getByRole("button", { name: "Disconnect Claude Code" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect Claude Code" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Disconnected." })).toBeVisible();
  const again = card.getByRole("button", { name: "Connect Claude Code" });
  await expect(again).toBeVisible();
  await again.evaluate((el) => el.setAttribute("data-test-mark", "again"));
  // The redraw has come, and is done.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.targets))
    .toBeGreaterThan(targets);
  await expect(page.locator('article[data-test-mark="card"]')).toHaveCount(1);
  await expect(page.locator('button[data-test-mark="again"]')).toBeVisible();
});

test("a card says that connecting lets the tool run quadit without asking, and offers no switch for it", async ({
  page,
}) => {
  await open(page, { connected: false, handshake: null, slowMs: 0 });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByText(/a login file for Claude Code, and lets it run quadit without asking/)).toBeVisible();
  await card.getByRole("button", { name: "More options for Claude Code" }).click();
  await expect(card.getByRole("form", { name: "How to connect Claude Code" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /without asking/ })).toHaveCount(0);
  await expect(page.getByText(/without asking each time/)).toHaveCount(0);
});

test("a connected card that is not listening makes the line to write its main step, and the page says the two steps above the cards", async ({
  page,
}) => {
  await open(page, { connected: true, handshake: { state: "connected", listening: false }, slowMs: 0 });
  const steps = page.getByRole("region", { name: "To have an agent answer you in Quadit" });
  await expect(steps.getByText("Connect it here.")).toBeVisible();
  await expect(steps.locator("code")).toHaveText("listen to Quadit");
  await expect(steps.getByText(/^Other ways: MCP \(under More options\)/)).toBeVisible();

  const card = page.getByRole("article", { name: "Claude Code" });
  const step = card.getByRole("group", { name: "Next: have Claude Code listen" });
  await expect(
    step.getByText(
      "Not listening yet. To have it answer what you write in Quadit, open Claude Code in your project’s folder and write:",
    ),
  ).toBeVisible();
  await expect(step.locator("code")).toHaveText("listen to Quadit");
  await expect(step.getByText("It listens in the background, so you can keep using that chat.")).toBeVisible();
  await step.getByRole("button", { name: "Copy “listen to Quadit” for Claude Code" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.copied))
    .toBe("listen to Quadit");

  // Listening to one project from a chat: what listens, what it answers, how to stop it, and how to add the project
  // nothing hears; the step is gone.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: {
        listeners: [{ project: { key: "SVA", name: "Samurai vs Aliens" }, by: "a chat" }],
        pushed: false,
        unheard: ["GS"],
      },
    };
  });
  await expect(card.getByText("Listening to Samurai vs Aliens, from a chat")).toBeVisible({ timeout: 10_000 });
  await expect(
    card.getByText(
      "It answers what you assign to it or ask it in Quadit while that chat is open. One chat listens to a project at a time. To stop, tell that chat to stop listening.",
    ),
  ).toBeVisible();
  await expect(
    card.getByText("To have it listen to GS too, write “listen to Quadit for GS” in a chat in that project’s folder."),
  ).toBeVisible();
  await expect(step).toHaveCount(0);

  // A project from a chat and everything else from a companion: a line each, and how a companion stops. Focus on
  // Disconnect stays there: what listens changing leaves the buttons beside the name alone.
  const disconnect = card.getByRole("button", { name: "Disconnect Claude Code" });
  await disconnect.focus();
  await disconnect.evaluate((el) => el.setAttribute("data-test-mark", "disconnect"));
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: {
        listeners: [{ by: "a companion" }, { project: { key: "SVA", name: "Samurai vs Aliens" }, by: "a chat" }],
        pushed: false,
        unheard: [],
      },
    };
  });
  await expect(card.getByText("Listening to everything else, from a companion")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Listening to Samurai vs Aliens, from a chat")).toBeVisible();
  await expect(
    card.getByText("A companion runs in a terminal, and stops with Ctrl-C or when that terminal closes."),
  ).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-test-mark"))).toBe("disconnect");
  await expect(card.getByText(/^To have it listen to/)).toHaveCount(0);

  // A companion of everything while GS keeps its items for its own listener, stopped: everything else, not everything.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: { listeners: [{ by: "a companion" }], pushed: false, unheard: ["GS"] },
    };
  });
  await expect(card.getByText("Listening to everything else, from a companion")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Listening to everything, from a companion")).toHaveCount(0);
});

test("a card says what the app does by itself: Connecting, and why it could not", async ({ page }) => {
  await open(page, {
    connected: true,
    handshake: { state: "waiting", code: "K7QX4M" },
    self: { proving: { state: "running" } },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByText("Connecting…")).toBeVisible();
  await expect(card.getByText(/^Connect to Quadit/)).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.self = {
      proving: { state: "failed", reason: "it took longer than two minutes" },
    };
  });
  await expect(
    card.getByText(
      "Quadit could not run Claude Code by itself (it took longer than two minutes). Say this in Claude Code instead:",
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Connect to Quadit K7QX4M")).toBeVisible();
});

test("a connected card offers Run by Quadit, chooses a project and a folder in the card, and says what each project does", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false },
    runs: { agent: "@claude-code", entries: [] },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(
    card.getByText(
      "Quadit can start Claude Code for you when you assign @claude-code a task or comment on one, in the project’s folder on this Mac.",
    ),
  ).toBeVisible({ timeout: 10_000 });

  // Choosing, in the card: Start running only once a project and a folder are chosen.
  await card.getByRole("button", { name: "Run Claude Code by Quadit for a project" }).click();
  const start = card.getByRole("button", { name: "Start running" });
  await expect(start).toBeDisabled();
  await card.getByLabel("Which project?").selectOption("GS");
  await expect(start).toBeDisabled();
  await card.getByRole("button", { name: "Choose folder…" }).click();
  await expect(card.getByText("~/devel/game", { exact: true })).toBeVisible();
  await expect(
    card.getByText(
      "Claude Code runs there with full access, as you, whenever you assign @claude-code a task in GS or comment on one. Only your words, or those of your other agents, start it.",
    ),
  ).toBeVisible();
  await start.click();
  expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.started)).toEqual([
    ["claude", "GS", "/Users/ann/devel/game"],
  ]);
  await expect(card.getByText("Runs GS in ~/devel/game.")).toBeVisible();
  await expect(card.getByText("Starting…")).toBeVisible();

  // A line changing under a focused Stop running leaves focus there; a refused write is said under its line.
  const stop = card.getByRole("button", { name: "Stop running GS for @claude-code" });
  await stop.focus();
  await stop.evaluate((el) => el.setAttribute("data-test-mark", "stop"));
  await page.evaluate(() => {
    const runs = (window as unknown as { stand: Stand }).stand.runs;
    if (runs)
      runs.entries = runs.entries.map((e) => ({
        ...e,
        status: { state: "working", task: "GS-3" },
        blocked: [{ task: "GS-2", error: "forbidden: no" }],
      }));
  });
  await expect(card.getByText("Working on GS-3.")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Quadit could not record how a run on GS-2 ended (forbidden: no).")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-test-mark"))).toBe("stop");
  await expect(card.getByRole("button", { name: "Run @claude-code by Quadit for another project" })).toBeVisible();

  // Stop running: the line goes, and the offer is back.
  await stop.click();
  expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.stopped)).toEqual(["e1"]);
  await expect(card.getByText("Runs GS in ~/devel/game.")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Run Claude Code by Quadit for a project" })).toBeVisible();
});

test("a card says nothing of Run by Quadit for a tool Quadit cannot run, nor before it is connected", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false },
    runs: null,
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByText(/^Not listening yet/)).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/^Quadit can start/)).toHaveCount(0);

  await page.evaluate(() => {
    const stand = (window as unknown as { stand: Stand }).stand;
    stand.runs = { agent: "@claude-code", entries: [] };
    stand.handshake = { state: "waiting", code: "K7QX4M" };
  });
  await expect(card.getByText("Connect to Quadit K7QX4M")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/^Quadit can start/)).toHaveCount(0);
});

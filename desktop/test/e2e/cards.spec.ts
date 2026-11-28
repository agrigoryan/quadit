// Connect agents' page on its own, in a plain headless browser: the built
// page (out/pages/connect.html) with the app's side played by a stand-in of
// its pages API, which the test steers. No app, no server: what is checked
// is that the page changes a card's nodes only when what the card shows
// changes, so that focus, a selection or a click inside it survive an
// answer about where its tool stands and the redraw after a Disconnect; and
// Run by Quadit's states on a connected card (agent-runs-contract.md §8.2).

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const PAGE = pathToFileURL(join(__dirname, "../../out/pages/connect.html")).href;
/** What the page calls this computer: it goes by the browser's platform, the one the test runs on. */
const HERE = process.platform === "darwin" ? "this Mac" : "this computer";
/** Who answers for the agent: the person signed in here. */
const ME = { handle: "ann", me: true };

/** What the stand-in answers; the test changes it through `window.stand`. */
interface Stand {
  connected: boolean;
  handshake: unknown;
  /** What the app does by itself for the tool (SelfRun); absent: nothing. */
  self?: unknown;
  /** The last line the page put on the clipboard. */
  copied?: string;
  /** What Quadit runs the tool for (RunsView); absent: Quadit cannot run it. */
  runs?: { agent: string; entries: Record<string, unknown>[]; unreadable?: true } | null;
  /** What the page asked Quadit to start and stop running. */
  started?: string[][];
  stopped?: string[];
  /** Where the page that asked wants Connect agents (ConnectFocusView); absent: none. */
  focus?: unknown;
  /** The choices the page planned a Connect with. */
  planned?: unknown[];
  /** The connections the page planned a Disconnect of. */
  unplanned?: unknown[];
  /** Claude Code works in another workspace too (Personal, as @claude-code); absent: in none. */
  elsewhere?: boolean;
  /** Claude Code has no login of its own (it works as this computer's default login), which works in `defaultIn`. */
  defaultIn?: string;
  /** The page asked to be taken away. */
  closed?: boolean;
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
      // Claude Code's connection in the workspace the page is over: every call about it names it.
      const CLAUDE_HERE = { tool: "claude", serverId: "s1", workspaceId: "w1", agentId: "u-claude" };
      (window as unknown as { quaditPages: unknown }).quaditPages = {
        planConnect: async (choice: unknown) => {
          state.planned = [...(state.planned ?? []), choice];
          return { ok: true, plan };
        },
        applyConnect: async () => {
          state.connected = true;
          return { ok: true, hint: "", connection: { ref: CLAUDE_HERE, workspace: "E2E" }, added: !!state.elsewhere };
        },
        connectTarget: async () => {
          state.targets++;
          return {
            serverId: "s1",
            serverName: "Work",
            summary,
            openedByPage: false,
            ...(state.focus ? { focus: state.focus } : {}),
          };
        },
        connectState: async () => {
          await wait(state.slowMs);
          return {
            at: { serverId: "s1", workspaceId: "w1" },
            defaultLogin: state.defaultIn
              ? [{ server: "https://q.example", agent: "@ann", workspaceId: state.defaultIn }]
              : [],
            claudePlugin: false,
            cli: {
              found: "/usr/local/bin/quadit",
              version: "9.9.9",
              linkInto: null,
              profile: null,
              pathFolder: null,
              manual: null,
            },
            harnesses: [
              {
                id: "claude",
                name: "Claude Code",
                initials: "CC",
                installed: true,
                mcp: true,
                cliIdentity: state.defaultIn ? "default" : "own",
                listenVerified: true,
                chatListens: "background",
                allows: true,
                skillChangedByHand: false,
                connected: state.connected
                  ? {
                      ref: CLAUDE_HERE,
                      methods: ["cli"],
                      server: "Work",
                      workspace: "E2E",
                      agent: "@claude-code",
                      folders: [],
                    }
                  : null,
                elsewhere: state.elsewhere
                  ? [
                      {
                        ref: { ...CLAUDE_HERE, workspaceId: "w2" },
                        methods: ["cli"],
                        server: "Work",
                        workspace: "Personal",
                        agent: "@claude-code",
                        folders: [],
                      },
                    ]
                  : [],
              },
            ],
          };
        },
        toolSelf: async () => (state.connected ? (state.self ?? { proving: null }) : null),
        runEntries: async () => state.runs ?? null,
        // Nothing waits on the agent: Start running is let go once this is answered.
        runWaiting: async () => null,
        agentProjects: async () => ({
          ok: true,
          projects: [
            { key: "SVA", name: "Samurai vs Aliens" },
            { key: "GS", name: "Getting started" },
          ],
        }),
        pickFolder: async () => ({ path: "/Users/ann/devel/game", shown: "~/devel/game" }),
        startRunning: async (ref: { tool: string }, project: string, folder: string) => {
          state.started = [...(state.started ?? []), [ref.tool, project, folder]];
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
        planDisconnect: async (ref: unknown) => {
          state.unplanned = [...(state.unplanned ?? []), ref];
          return { ok: true, plan };
        },
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
        closeConnect: async () => {
          state.closed = true;
        },
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
  await expect(card.locator('[data-test-mark="line"]')).toHaveText("Connect to Quadit K7QX4M in E2E");

  // A selection of the line survives too.
  await page.locator('[data-test-mark="line"]').selectText();
  const selected = await page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.asks), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(selected + 1);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("Connect to Quadit K7QX4M in E2E");

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
  await expect(card.getByText("Connect to Quadit K7QX4M in E2E")).toBeVisible();
});

test("a connected card offers Run by Quadit, chooses a project and a folder in the card, and says what each project does", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    runs: { agent: "@claude-code", entries: [] },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(
    card.getByText(
      `Quadit can start Claude Code for you when you assign @claude-code a task or comment on one, in the project’s folder on ${HERE}.`,
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
  await expect(card.getByText("Connect to Quadit K7QX4M in E2E")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/^Quadit can start/)).toHaveCount(0);
});

test("while Quadit runs a project for the agent, the card asks no chat to listen and never calls the runner a chat", async ({
  page,
}) => {
  const ready = {
    id: "e1",
    project: "SVA",
    folder: "~/devel/game",
    program: "claude",
    status: { state: "ready" },
    blocked: [],
  };
  // Served, though the server does not say it listens yet: no next step.
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    runs: { agent: "@claude-code", entries: [ready] },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByText("Runs SVA in ~/devel/game.")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole("group", { name: "Next: have Claude Code listen" })).toHaveCount(0);

  // The runner holds SVA's listener: no line of its own, nothing of a chat; a chat may still listen to GS.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: {
        listeners: [{ project: { key: "SVA", name: "Samurai vs Aliens" }, by: "Quadit's runner", runner: true }],
        pushed: false,
        unheard: ["GS"],
      },
    };
  });
  await expect(
    card.getByText("To have it listen to GS too, write “listen to Quadit for GS” in a chat in that project’s folder."),
  ).toBeVisible({ timeout: 10_000 });
  // The status lines only: "Listening is not verified…" is there, hidden, on every card.
  await expect(card.getByText(/^Listening/).filter({ visible: true })).toHaveCount(0);
  await expect(card.getByText(/while that chat is open/)).toHaveCount(0);

  // A chat listening to GS keeps its lines.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: {
        listeners: [
          { project: { key: "SVA", name: "Samurai vs Aliens" }, by: "Quadit's runner", runner: true },
          { project: { key: "GS", name: "Getting started" }, by: "a chat" },
        ],
        pushed: false,
        unheard: [],
      },
    };
  });
  await expect(card.getByText("Listening to Getting started, from a chat")).toBeVisible({ timeout: 10_000 });
  await expect(
    card.getByText(/^It answers what you assign to it or ask it in Quadit while that chat is open/),
  ).toBeVisible();
  await expect(card.getByText("Listening to Samurai vs Aliens, from Quadit's runner")).toHaveCount(0);

  // A runner on another computer holds WEB, which this computer does not run: said, with that computer's name.
  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = {
      state: "connected",
      listening: true,
      heard: {
        listeners: [
          { project: { key: "SVA", name: "Samurai vs Aliens" }, by: "Quadit's runner", runner: true },
          { project: { key: "WEB", name: "Website" }, by: "Quadit's runner", runner: true, machine: "Bea's iMac" },
        ],
        pushed: false,
        unheard: [],
      },
    };
  });
  await expect(card.getByText("Quadit runs WEB on Bea's iMac.")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText(/^Quadit runs SVA/)).toHaveCount(0);
});

test("a card offers no run of an agent someone else answers for without naming them, and none when it cannot tell", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: { handle: "bob", me: false } },
    runs: { agent: "@claude-code", entries: [] },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(
    card.getByText(
      `Quadit can start Claude Code under your account when @bob assigns @claude-code a task or writes to it on one, in the project’s folder on ${HERE}.`,
    ),
  ).toBeVisible({ timeout: 10_000 });
  await card.getByRole("button", { name: "Run Claude Code by Quadit for a project" }).click();
  await card.getByLabel("Which project?").selectOption("GS");
  await expect(
    card.getByText(
      `Claude Code runs there with full access, under your account on ${HERE}, whenever @bob assigns @claude-code a task in GS or writes to it on one. Only @bob’s words, or those of @bob’s other agents, start it.`,
    ),
  ).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { stand: Stand }).stand.handshake = { state: "connected", listening: false };
  });
  await expect(
    card.getByText("Quadit cannot tell who answers for @claude-code, so it does not offer to run it."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Run Claude Code by Quadit for a project" })).toBeHidden();
  await expect(card.getByRole("button", { name: "Start running" })).toHaveCount(0);
});

test("a card says when it cannot read what Quadit runs, rather than offering to run it", async ({ page }) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    runs: { agent: "@claude-code", entries: [], unreadable: true },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(
    card.getByText(`Quadit could not read which projects it runs on ${HERE}. It tries again in a moment.`),
  ).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Run Claude Code by Quadit for a project" })).toBeHidden();
});

test("opened at an agent's card to run it, the card is in view and focused, with Run by Quadit's choice open", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    runs: { agent: "@claude-code", entries: [] },
    focus: { id: 1, intent: "run", tool: "claude", agent: { id: "u2", handle: "claude-code" } },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByLabel("Which project?")).toBeFocused({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Start running" })).toBeDisabled();
  await expect(card).toBeInViewport();
  // It only prepares: nothing started.
  expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.started)).toBeUndefined();
});

test("opened at an agent's card to disconnect it, the sheet holds what disconnecting does, for the person to confirm", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    focus: { id: 1, intent: "disconnect", tool: "claude" },
    slowMs: 0,
  });
  // In the sheet itself, in the card's place: no sheet over the sheet.
  await expect(page.getByRole("button", { name: "Disconnect Claude Code" }).last()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("What disconnecting Claude Code changes")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Claude Code" })).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.connected)).toBe(true);
  // Closed without disconnecting: the card is back, in the sheet.
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("article", { name: "Claude Code" })).toBeVisible();
});

test("opened at an agent's card with nothing more to do, the card is brought forward and focused", async ({ page }) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    focus: { id: 1, intent: "connect", tool: "claude" },
    slowMs: 0,
  });
  await expect(page.getByRole("article", { name: "Claude Code" })).toBeFocused({ timeout: 10_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("opened to connect an agent no tool works as here, it says which, and a card's Connect uses that agent", async ({
  page,
}) => {
  const helper = "0190f3a2-7b1c-7d4e-9a0b-1c2d3e4f5a6c";
  await open(page, {
    connected: false,
    handshake: null,
    focus: { id: 1, intent: "connect", agent: { id: helper, handle: "helper" } },
    slowMs: 0,
  });
  await expect(page.getByText(`Choose what should work as @helper on ${HERE}.`)).toBeVisible({ timeout: 10_000 });
  // Titled with the agent, and named so.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("@helper");
  await expect(page.getByRole("main", { name: "@helper" })).toBeVisible();
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(
    card.getByText(
      "Claude Code will work as @helper, and be able to take tasks, ask you questions and report back here.",
    ),
  ).toBeVisible();
  await card.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.planned))
    .toEqual([expect.objectContaining({ harness: "claude", agent: { id: helper } })]);
});

test("opened at an agent, it is a sheet of that agent alone over the page: the whole page at a click, closed by a click outside", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    focus: { id: 1, intent: "connect", tool: "claude" },
    slowMs: 0,
  });
  await expect(page.getByRole("article", { name: "Claude Code" })).toBeFocused({ timeout: 10_000 });
  const steps = page.getByRole("region", { name: "To have an agent answer you in Quadit" });
  await expect(steps).toBeHidden();
  await expect(page.getByText(/^Connect an agent here, then tell it to listen/)).toBeHidden();
  // No name of the agent is known here (the summary lists none): the page's own title.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect agents");

  await page.getByRole("button", { name: "All agents on this computer" }).click();
  await expect(steps).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect agents");
  await expect(page.getByRole("button", { name: "All agents on this computer" })).toBeHidden();
});

test("a click outside the sheet of one agent closes it; nothing is done", async ({ page }) => {
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    focus: { id: 1, intent: "connect", tool: "claude" },
    slowMs: 0,
  });
  await expect(page.getByRole("article", { name: "Claude Code" })).toBeFocused({ timeout: 10_000 });
  await page.mouse.click(5, 300);
  await expect.poll(() => page.evaluate(() => (window as unknown as { stand: Stand }).stand.closed)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.connected)).toBe(true);
});

test("opened without an agent, it is the whole page as before", async ({ page }) => {
  await open(page, { connected: true, handshake: { state: "connected", listening: false, owner: ME }, slowMs: 0 });
  await expect(page.getByRole("region", { name: "To have an agent answer you in Quadit" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "All agents on this computer" })).toBeHidden();
});

test("the sheet of one agent is titled with its name, its handle beside it, when the workspace's summary gives them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // The summary the page's stand-in gives lists the agent.
    const agents = [
      { id: "u2", handle: "claude-code", name: "Claude", state: "idle", detail: "", path: "/e2e", usable: true },
    ];
    const set = () => {
      const pages = (
        window as unknown as { quaditPages?: { connectTarget: () => Promise<{ summary: { agents: unknown[] } }> } }
      ).quaditPages;
      if (!pages) return void setTimeout(set, 0);
      const target = pages.connectTarget;
      pages.connectTarget = async () => {
        const answer = await target();
        return { ...answer, summary: { ...answer.summary, agents } };
      };
    };
    set();
  });
  await open(page, {
    connected: true,
    handshake: { state: "connected", listening: false, owner: ME },
    focus: { id: 1, intent: "connect", tool: "claude", agent: { id: "u2", handle: "claude-code" } },
    slowMs: 0,
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Claude @claude-code", { timeout: 10_000 });
  await expect(page.getByRole("main", { name: "Claude @claude-code" })).toBeVisible();
  await page.getByRole("button", { name: "All agents on this computer" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect agents");
});

for (const elsewhere of [false, true])
  test(`Undo right after ${elsewhere ? "Connect here as well" : "a first Connect"} takes back the connection just made`, async ({
    page,
  }) => {
    // The state the page draws from comes slowly: the card is set up before the page draws it again.
    await open(page, { connected: false, handshake: { state: "waiting", code: "K7QX4M" }, slowMs: 1_500, elsewhere });
    const card = page.getByRole("article", { name: "Claude Code" });
    await card
      .getByRole("button", { name: elsewhere ? "Connect Claude Code here as well" : "Connect Claude Code" })
      .click();
    await card.getByRole("button", { name: /^Undo Claude Code/ }).click();
    await expect(page.getByRole("dialog", { name: "What disconnecting Claude Code changes" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { stand: Stand }).stand.unplanned)).toEqual([
      { tool: "claude", serverId: "s1", workspaceId: "w1", agentId: "u-claude" },
    ]);
  });

// Where the default login works: in another workspace, a login is made here for an agent chosen; here, the tool works as it.
for (const [defaultIn, asked] of [
  ["w2", true],
  ["w1", false],
] as const)
  test(`More options ${asked ? "asks" : "does not ask"} which agent a tool on this computer's login works as, that login working in ${defaultIn}`, async ({
    page,
  }) => {
    await open(page, { connected: false, handshake: null, slowMs: 0, defaultIn });
    const card = page.getByRole("article", { name: "Claude Code" });
    await card.getByRole("button", { name: "More options for Claude Code" }).click();
    const workAs = card.getByText("Work as", { exact: true });
    if (asked) await expect(workAs).toBeVisible();
    else await expect(workAs).toBeHidden();
  });

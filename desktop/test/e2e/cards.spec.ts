// Connect agents' page on its own, in a plain headless browser: the built
// page (out/pages/connect.html) with the app's side played by a stand-in of
// its pages API, which the test steers. No app, no server: what is checked
// is that the page changes a card's nodes only when what the card shows
// changes, so that focus, a selection or a click inside it survive an
// answer about where its tool stands and the redraw after a Disconnect.

import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PAGE = `file://${join(__dirname, "../../out/pages/connect.html")}`;

/** What the stand-in answers; the test changes it through `window.stand`. */
interface Stand {
  connected: boolean;
  handshake: unknown;
  /** What the app does by itself for the tool (SelfRun); absent: nothing. */
  self?: unknown;
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
                allows: true,
                skillChangedByHand: false,
                connected: state.connected
                  ? { methods: ["cli"], server: "Work", workspace: "E2E", agent: "@claude-code" }
                  : null,
              },
            ],
          };
        },
        toolSelf: async () => (state.connected ? (state.self ?? { proving: null, answering: "none" }) : null),
        setAnswering: async (_id: string, on: boolean) => {
          state.self = { proving: null, answering: on ? "on" : "paused" };
        },
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
        copyText: async () => {},
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
  await expect(card.getByText(/and lets Claude Code run quadit without asking/)).toBeVisible();
  await card.getByRole("button", { name: "More options for Claude Code" }).click();
  await expect(card.getByRole("form", { name: "How to connect Claude Code" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /without asking/ })).toHaveCount(0);
  await expect(page.getByText(/without asking each time/)).toHaveCount(0);
});

test("a card says what the app does by itself: Connecting, why it could not, and answering with Pause and Resume", async ({
  page,
}) => {
  await open(page, {
    connected: true,
    handshake: { state: "waiting", code: "K7QX4M" },
    self: { proving: { state: "running" }, answering: "on" },
    slowMs: 0,
  });
  const card = page.getByRole("article", { name: "Claude Code" });
  await expect(card.getByText("Connecting…")).toBeVisible();
  await expect(card.getByText(/^Connect to Quadit/)).toHaveCount(0);

  const set = (stand: Partial<Stand>) =>
    page.evaluate((s) => Object.assign((window as unknown as { stand: Stand }).stand, s), stand);
  await set({ self: { proving: { state: "failed", reason: "it took longer than two minutes" }, answering: "on" } });
  await expect(
    card.getByText(
      "Quadit could not run Claude Code by itself (it took longer than two minutes). Say this in Claude Code instead:",
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Connect to Quadit K7QX4M")).toBeVisible();

  await set({ handshake: { state: "connected", listening: true }, self: { proving: null, answering: "on" } });
  await expect(card.getByText("Answers by itself while Quadit is open")).toBeVisible({ timeout: 10_000 });
  await card.getByRole("button", { name: "Pause Claude Code answering by itself" }).click();
  await expect(card.getByText("Paused. It answers when you ask it in Claude Code.")).toBeVisible();
  await card.getByRole("button", { name: "Resume Claude Code answering by itself" }).click();
  await expect(card.getByText("Answers by itself while Quadit is open")).toBeVisible();

  await set({ self: { proving: null, answering: "on", missed: "it took too long" } });
  await expect(card.getByText("It could not answer one item (it took too long).")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Show the log of what Quadit ran for Claude Code" })).toBeVisible();
  await set({ self: { proving: null, answering: "guarded" } });
  await expect(
    card.getByText("Paused: it was started more than six times in a minute. Resume when you have looked."),
  ).toBeVisible({ timeout: 10_000 });
  // A tool the app does not run says nothing of answering.
  await set({ self: { proving: null, answering: "none" } });
  await expect(card.getByText(/answer/i)).toHaveCount(0, { timeout: 10_000 });
});

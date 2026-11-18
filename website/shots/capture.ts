// Takes the website's screenshots of the real app. It starts the binary
// `make build` made on a free port with a new, empty data directory (as
// web/e2e/global-setup.ts does), fills it with seed.sh, signs in as the
// demo workspace's owner and photographs each screen the site shows, at
// device pixel ratio 2 in the dark theme: desktop 1440×900, phone 390×844.
// The PNGs land in website/shots/raw/; optimize.sh turns them into the
// AVIF, WebP and PNG files the page uses.
//
//   make build
//   node website/shots/capture.ts                 # from the repository's root
//   QUADIT_SHOTS_URL=http://127.0.0.1:4791 node website/shots/capture.ts   # an already seeded server
//
// Playwright comes from the web app's own dependencies (web/node_modules).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "web/package.json"));
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");

const WS = "harbor-studio";
const OWNER = { email: "maya@harbor.example", password: "correct-horse-battery" };
const OUT = join(here, "raw");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function main() {
  await mkdir(OUT, { recursive: true });
  let url = process.env.QUADIT_SHOTS_URL;
  let stop = async () => {};
  if (!url) ({ url, stop } = await startAndSeed());
  const browser = await chromium.launch();
  try {
    await desktopShots(browser, url);
    await phoneShots(browser, url);
  } finally {
    await browser.close();
    await stop();
  }
  console.log(`screenshots in ${OUT}`);
}

/** A new server with the demo workspace in it, and how to stop it. */
async function startAndSeed() {
  const dir = await mkdtemp(join(tmpdir(), "quadit-shots-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(join(root, "bin/quadit"), ["serve", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--url", url], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_CONFIG: join(dir, "cli.json") },
  });
  const stop = async () => {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntilUp(url);
    await promisify(execFile)("bash", [join(here, "seed.sh")], {
      cwd: root,
      env: { ...process.env, QUADIT_SEED_URL: url, QUADIT_BIN: join(root, "bin/quadit"), HOME: dir },
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, stop };
}

/** A browser signed in as the owner, in the dark theme, at twice the pixels. */
async function signedIn(browser: Browser, url: string, phone: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: url,
    viewport: phone ? PHONE : DESKTOP,
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => localStorage.setItem("quadit.theme", "dark"));
  const res = await context.request.post("/api/v1/auth/login", { data: OWNER });
  if (!res.ok()) throw new Error(`sign-in: ${res.status()} ${await res.text()}`);
  return context;
}

async function shot(page: Page, name: string) {
  // Let fonts, pictures and the live connection settle.
  await page.evaluate(() => document.fonts.ready);
  // The app holds a live connection open, so the network is never idle: wait for the pictures instead.
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
}

async function docId(page: Page, title: string) {
  const res = await page.request.get(`/api/v1/w/${WS}/docs?format=text`);
  const line = (await res.text()).split("\n").find((l) => l.includes(title)) ?? "";
  const id = /\(([0-9a-f-]{36})\)/.exec(line)?.[1];
  if (!id) throw new Error(`no page "${title}"`);
  return id;
}

async function desktopShots(browser: Browser, url: string) {
  const context = await signedIn(browser, url, false);
  const page = await context.newPage();

  await page.goto(`/${WS}/p/TDW/board`);
  await page.getByText("Redraw the tide chart at 120 fps").first().waitFor();
  await shot(page, "board");

  await page.goto(`/${WS}/p/TDW/tasks`);
  await page.getByRole("link", { name: "Open TDW-2", exact: true }).waitFor();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Command palette" }).fill("chart");
  await page.waitForTimeout(300);
  await shot(page, "palette");
  await page.keyboard.press("Escape");

  await page.goto(`/${WS}/task/TDW-1`);
  const question = page.getByRole("region", { name: "Decisions" }).getByRole("article", { name: "Which direction for the 2.0 icon?" });
  await question.waitFor();
  await question.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, "task-decision");

  await question.getByRole("button", { name: /Compare Tide clock/ }).first().click();
  await page.waitForTimeout(600);
  await shot(page, "compare");
  await page.keyboard.press("Escape");

  const plan = await docId(page, "2.0 launch plan");
  await page.goto(`/${WS}/docs/${plan}`);
  const words = page.getByRole("textbox", { name: "Page text" }).locator('[data-style-type="comment"]').first();
  await words.waitFor();
  await words.click();
  await page.waitForTimeout(400);
  await shot(page, "doc-comment");

  const stations = await docId(page, "Tide stations");
  await page.goto(`/${WS}/docs/${stations}`);
  await page.getByText("Port Townsend").first().waitFor();
  await shot(page, "database");

  await page.goto(`/${WS}/agents`);
  await page.getByText("Forge").first().waitFor();
  await shot(page, "agents");

  await page.goto(`/${WS}/decisions`);
  await page.getByText("Which direction for the 2.0 icon?").first().waitFor();
  await shot(page, "decisions");

  await page.goto(`/${WS}/inbox`);
  await page.getByRole("main").getByText(/TDW-\d/).first().waitFor();
  await shot(page, "inbox"); // for the README only

  await context.close();
}

async function phoneShots(browser: Browser, url: string) {
  const context = await signedIn(browser, url, true);
  const page = await context.newPage();

  await page.goto(`/${WS}/task/TDW-1`);
  const question = page.getByRole("article", { name: "Which direction for the 2.0 icon?" });
  await question.waitFor();
  await question.evaluate((el) => el.scrollIntoView({ block: "start" }));
  // The options are a row to swipe through: bring the recommended one into view.
  await question.getByRole("article", { name: "Tide clock" }).evaluate((el) => el.scrollIntoView({ inline: "center", block: "nearest" }));
  await page.waitForTimeout(400);
  await shot(page, "phone-decision");

  await question.getByRole("button", { name: "Compare side by side" }).tap();
  // Swipe to the recommended option with its dot.
  await page.getByRole("button", { name: "Tide clock", exact: true }).tap();
  await page.waitForTimeout(800);
  await shot(page, "phone-compare");

  await context.close();
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });
}

async function waitUntilUp(url: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${url}/readyz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`quadit serve did not answer on ${url} within 20 s`);
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  const exited = new Promise((done) => server.once("exit", done));
  server.kill("SIGTERM");
  await exited;
}

await main();

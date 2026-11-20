// Records the film at the top of the website: one task in the real app,
// worked by the agent Claude, the whole app in frame. The task "App icon for
// 2.0" is Claude's; Claude takes it (In Progress) and says so, asks which of
// three icons with a picture on each, the recommended one is picked in the
// page, and Claude posts the finished icon and marks the task Done. Claude's
// steps are the quadit CLI with Claude's own token, as an agent works, timed
// against the film (film.ts). Nobody is seen operating the app: no pointer,
// no forms; the page scrolls itself to what comes next.
//
// It starts its own server on a free port with an empty data directory and
// seeds it as capture.ts does (server.ts), then adds what only the film
// needs: the agent Claude and the task, made through the CLI before filming
// starts, and the board without the seed's own icon task. The frames go to
// website/shots/raw/video/ (ignored by git); encode-video.sh turns them into
// website/video/. The film plays once and ends on the finished task, which
// stays on screen. About two minutes, most of it encoding.
//
//   make build
//   node website/shots/video.ts                   # from the repository's root: hero-app
//   node website/shots/video.ts --drift           # hero-app-drift: the camera leans a little toward each change
//   node website/shots/video.ts --captions        # hero-app-captions: a caption per beat

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import { type Film, prepare, startFilm } from "./film.ts";
import { QUADIT, WS, chromium, here, signedIn, startAndSeed } from "./server.ts";

const CAPTIONS = process.argv.includes("--captions");
const DRIFT = process.argv.includes("--drift");
const NAME = ["hero-app", DRIFT && "drift", CAPTIONS && "captions"].filter(Boolean).join("-");
const RAW = join(here, "raw/video", NAME);
const ART = join(here, "art");
const TITLE = "App icon for 2.0";
const QUESTION = "Which direction for the 2.0 icon?";

async function main() {
  const { url, dir, stop } = await startAndSeed();
  const browser = await chromium.launch();
  try {
    const context = await signedIn(browser, url, { motion: true });
    const { claude, key } = await cast(context, url, dir);
    await prepare(context);
    const page = await context.newPage();
    await page.goto(`/${WS}/task/${key}`);
    await page.getByRole("main").getByRole("button", { name: /^Assignee: Claude/ }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await pictures(page);

    await rm(RAW, { recursive: true, force: true });
    // How far the camera leans in toward a change: never so far that the app leaves the frame.
    const film = await startFilm(page, RAW, { lean: DRIFT ? 1.08 : 1 });
    await play(page, film, claude, key);
    const { beats, length } = await film.stop();

    console.log(`${NAME}: ${(length / 1000).toFixed(1)} s`);
    for (const beat of beats) console.log(`  ${(beat.at / 1000).toFixed(1).padStart(5)} s  ${beat.name}`);
  } finally {
    await browser.close();
    await stop();
  }
  // The film plays once and stays on its last frame: the poster is its first.
  const encoded = await promisify(execFile)("bash", [join(here, "encode-video.sh"), NAME]);
  process.stdout.write(encoded.stdout);
}

/**
 * The storyboard. Every hold is film time; each beat is a moment the report
 * names. One change finishes before the next starts, and the page never
 * scrolls while something in it is changing.
 */
async function play(page: Page, film: Film, claude: (...args: string[]) => Promise<void>, key: string) {
  const main = page.getByRole("main");
  const caption = (text: string | null) => (CAPTIONS ? film.caption(text) : Promise.resolve());
  const status = main.getByRole("button", { name: /^Status:/ });

  film.beat("the task, Claude's");
  await caption("Give an agent a task");
  await film.hold(1200);

  film.beat("Claude takes it: In Progress, and says so");
  await caption("It gets to work");
  await film.lean(status, 2400);
  await claude("take", key);
  await main.getByText("@claude is working on this").waitFor();
  await film.ring(status);
  await film.hold(1100);
  await claude("comment", key, "On it. Three directions coming.");
  const comment = main.getByRole("article").filter({ hasText: "On it. Three directions coming." });
  await comment.waitFor();
  await film.ring(comment);
  await film.lean(comment, 2000);
  await film.hold(1500);

  film.beat("Claude asks, with a picture per option");
  await caption("It asks when the call is yours");
  await claude(
    "ask",
    key,
    QUESTION,
    "option=Wave::One bold wave. Strong at large sizes, busy below 40 pt.",
    `file=${join(ART, "icon-wave.png")}`,
    "option=Tide clock::A dial with the moon and the water line. Says what the app does.",
    `file=${join(ART, "icon-tideclock.png")}`,
    "option=Lighthouse::Warm and friendly; the beam turns to noise when small.",
    `file=${join(ART, "icon-lighthouse.png")}`,
    "recommended=2",
    "why=Reads best at 29 pt on a busy home screen.",
    "ask=@maya",
  );
  const question = main.getByRole("article", { name: QUESTION });
  await question.getByText("Your answer is needed").waitFor();
  await pictures(page);
  await film.ring(question);
  await film.hold(800);
  // The cards with their "This one" buttons, whole.
  const tideClock = question.getByRole("article", { name: "Tide clock" });
  await film.scrollTo(tideClock, 700);
  await film.lean(question, 2400);
  await film.hold(2000);

  film.beat("the pick: Tide clock");
  await caption("You pick");
  await film.lean(tideClock, 2000);
  await film.hold(350);
  await film.press(tideClock.getByRole("button", { name: "This one", exact: true }));
  await tideClock.getByText("Picked").waitFor();
  await film.ring(tideClock);
  await film.hold(1400);

  film.beat("Claude's result, and Done");
  await caption("It finishes the job");
  await claude(
    "result",
    key,
    "The Tide clock icon, final, at every size from 1024 to 29 pt.",
    "checked=29, 40 and 60 pt on light and dark wallpapers",
    `file=${join(ART, "icon-tideclock.png")}`,
  );
  const result = main.getByRole("article").filter({ hasText: "The Tide clock icon, final" });
  await result.waitFor();
  await pictures(page);
  await film.scrollTo(result, 800);
  await film.ring(result);
  await film.lean(result, 2000);
  await film.hold(1400);
  await claude("update", key, "status=Done");
  await status.filter({ hasText: "Done" }).waitFor();
  await film.ring(status);
  await film.lean(null, 1800);
  // The last frame stays on the page once the film has played: the ring gone, the camera at rest, nothing moving.
  await film.hold(900);
  film.beat("the last frame, held");
  await film.hold(1000);
}

/**
 * The agent Claude, answering to Maya; the task, Claude's; and a way to run
 * the quadit CLI as Claude. The seed's own icon task goes to the trash, so
 * the board has only the one the film is about.
 */
async function cast(context: BrowserContext, url: string, dir: string) {
  // A write made with the sign-in cookie names its origin, as the app's pages do.
  const token = async (user?: string) => {
    const res = await context.request.post(`/api/v1/w/${WS}/tokens`, {
      data: { name: "video", ...(user ? { user } : {}) },
      headers: { Origin: url },
    });
    if (!res.ok()) throw new Error(`token: ${res.status()} ${await res.text()}`);
    return ((await res.json()) as { token: string }).token;
  };
  const cli = (as: string) => async (...args: string[]) =>
    (
      await promisify(execFile)(QUADIT, args, {
        env: { PATH: process.env.PATH ?? "", HOME: dir, QUADIT_URL: url, QUADIT_TOKEN: as, QUADIT_CONFIG: join(dir, "video-cli.json") },
      })
    ).stdout;
  const maya = cli(await token());
  await maya(
    "do",
    "agent.create",
    JSON.stringify({ name: "Claude", handle: "claude", responsible: "@maya", description: "Design, code and docs, through the quadit CLI" }),
  );
  await maya("do", "task.delete", JSON.stringify({ id: "TDW-1" }));
  const made = await maya(
    "--json",
    "do",
    "task.create",
    JSON.stringify({ project: "TDW", title: TITLE, assignee: "@claude", description: "Three directions for the home screen, legible at 29 pt." }),
  );
  const { key } = JSON.parse(made) as { key: string };
  const claude = cli(await token("@claude"));
  return { claude: async (...args: string[]) => void (await claude(...args)), key };
}

/** Waits until every picture on the page has loaded. */
async function pictures(page: Page) {
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
}

await main();

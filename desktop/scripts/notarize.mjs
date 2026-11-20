// Notarizing the signed macOS app, as electron-builder's afterSign step
// (electron-builder.config.cjs): the app is sent to Apple's notary service,
// and once Apple accepts it the ticket is stapled to it, before the .dmg and
// the .zip are made of it.
//
// Apple usually answers within minutes, but can take hours (a new Developer
// ID's first submissions do), so the wait has a limit, and the verdict is
// asked for again after it: a wait that broke off says nothing about the
// submission. Without a verdict the build fails, unless
// QUADIT_NOTARIZE_UNANSWERED_OK=true: then the app goes out signed and
// unstapled. macOS looks a ticket up by the app's signature, so that same
// app opens without a warning from the moment Apple accepts it.
//
//   QUADIT_NOTARIZE_WAIT            minutes to wait for the verdict (15)
//   QUADIT_NOTARIZE_UNANSWERED_OK   true: no verdict in that time is no failure
//   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_WAIT_MINUTES = 15;
const VERDICT_TRIES = 3;

/**
 * notarytool's arguments that say who is asking, from the environment, or
 * null when it names nobody.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[] | null}
 */
export function credentials(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  }
  return null;
}

/**
 * Sends the signed app at `app` to Apple and staples it when Apple accepts
 * it within `waitMinutes`: "stapled". With `unansweredOk`, an app Apple has
 * not answered for by then is left as it is: "unanswered". Throws when Apple
 * refuses the app, or has not answered and that is not allowed.
 *
 * @param {string} app
 * @param {{
 *   run: (tool: string, args: string[]) => Promise<string>,
 *   as: string[],
 *   waitMinutes: number,
 *   unansweredOk?: boolean,
 *   say: (line: string) => void,
 * }} with
 * @returns {Promise<"stapled" | "unanswered">}
 */
export async function notarize(app, { run, as, waitMinutes, unansweredOk = false, say }) {
  const dir = await mkdtemp(path.join(tmpdir(), "quadit-notarize-"));
  const zip = path.join(dir, `${path.basename(app, ".app")}.zip`);
  let id;
  try {
    await run("ditto", ["-c", "-k", "--keepParent", app, zip]);
    const sent = await run("xcrun", ["notarytool", "submit", zip, ...as, "--no-wait", "--output-format", "json"]);
    id = answer(sent).id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  say(`${path.basename(app)}: sent to Apple as submission ${id}, waiting up to ${waitMinutes} min for its verdict`);

  // The wait may end early (the time is up, the connection dropped): the verdict is what info says after it.
  await run("xcrun", ["notarytool", "wait", id, ...as, "--timeout", `${waitMinutes}m`]).catch(() => {});
  const status = await verdict(id, { run, as });

  if (status === "Accepted") {
    await run("xcrun", ["stapler", "staple", app]);
    say(`${path.basename(app)}: Apple accepted submission ${id}, and its ticket is stapled`);
    return "stapled";
  }
  if (status === "In Progress") {
    if (!unansweredOk) throw new Error(`submission ${id}: no verdict from Apple after ${waitMinutes} min`);
    say(
      `::warning::${path.basename(app)} goes out before Apple's verdict on submission ${id}: macOS warns on opening it until Apple accepts it.`,
    );
    return "unanswered";
  }
  say(await run("xcrun", ["notarytool", "log", id, ...as]).catch((err) => `no log from Apple: ${err.message}`));
  throw new Error(`submission ${id}: Apple answered ${status}`);
}

/** What Apple says of submission `id` now, asked again when the asking itself fails. */
async function verdict(id, { run, as }) {
  for (let tries = 1; ; tries++) {
    try {
      return answer(await run("xcrun", ["notarytool", "info", id, ...as, "--output-format", "json"])).status;
    } catch (err) {
      if (tries === VERDICT_TRIES) throw err;
    }
  }
}

/** notarytool's JSON answer in what it printed, which may begin with lines of progress. */
function answer(printed) {
  return JSON.parse(printed.slice(printed.indexOf("{")));
}

/** Runs `tool`, giving what it printed; its error output goes with a failure. */
function runTool(tool, args) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${tool} ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** electron-builder's afterSign: `context` names the app it has just signed. */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const as = credentials(process.env);
  if (!as) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await notarize(app, {
    run: runTool,
    as,
    waitMinutes: Number(process.env.QUADIT_NOTARIZE_WAIT) || DEFAULT_WAIT_MINUTES,
    unansweredOk: process.env.QUADIT_NOTARIZE_UNANSWERED_OK === "true",
    say: (line) => process.stdout.write(`${line}\n`),
  });
}

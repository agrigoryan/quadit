import { createHash } from "node:crypto";
import { expect, signInWithPassword, test } from "./desktop";
import type { HandoffEvent } from "./handoff-fake";

test("signing in with a password in the server's window opens the workspace", async ({ desktop, run }) => {
  const page = await desktop.addServer(run.server);
  await signInWithPassword(page);
  await expect(page.getByRole("navigation").first()).toBeVisible();
});

/** Plays the system browser's part: opens the connect address the app sent it to and gives the quadit:// link it is sent back with. */
async function browserApproves(connect: string): Promise<string> {
  const answer = await fetch(connect, { redirect: "manual" });
  expect(answer.status).toBe(302);
  const link = answer.headers.get("location") ?? "";
  expect(link).toMatch(/^quadit:\/\/connect\?/);
  return link;
}

test("signing in through the browser: the bar on the sign-in page starts it, the quadit:// link finishes it", async ({
  desktop,
  run,
}) => {
  test.skip(run.server !== run.fake, "the stand-in plays the browser's part; with the real server it is a person");
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);

  // The bar over the sign-in page is the app's own page, in the same window.
  const bar = await desktop.signInBar();
  await expect.poll(() => desktop.barShown(run.server)).toBe(true);
  await bar.getByRole("button", { name: "Sign in with your browser" }).click();

  // The system browser is sent to the server's connect page with a state and an S256 challenge.
  await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
  const connect = new URL((await desktop.recorded()).opened[0] ?? "");
  expect(connect.origin + connect.pathname).toBe(`${run.server}/desktop/connect`);
  expect(connect.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(connect.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const link = await browserApproves(connect.href);
  await desktop.openLink(link);

  // The window redeemed the code with the verifier, and is signed in.
  const finished = async () =>
    ((await (await fetch(`${run.fake}/__fake/log`)).json()) as HandoffEvent[]).filter(
      (event) => event.step === "finish",
    );
  await expect.poll(finished).toEqual([{ step: "finish", ok: true, detail: connect.searchParams.get("state") }]);
  await expect(page).toHaveURL(/\/e2e(\/|$)/);
  await expect(page.getByRole("navigation").first()).toBeVisible();
  // The bar is gone with the sign-in page.
  await expect.poll(() => desktop.barShown(run.server)).toBe(false);
});

test("a quadit://connect link the app did not start, or for another server, is refused", async ({ desktop, run }) => {
  test.skip(run.server !== run.fake, "uses the stand-in's connect page");
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);

  // A link made by someone else: a state this app never made.
  const challenge = createHash("sha256").update("x".repeat(43)).digest("base64url");
  const forged = await browserApproves(`${run.server}/desktop/connect?state=${"A".repeat(43)}&challenge=${challenge}`);
  await desktop.openLink(forged);
  await expect
    .poll(async () => (await desktop.recorded()).dialogs)
    .toEqual([expect.stringMatching(/was not started from this app/)]);

  // A real flow, but the link names another server.
  const list = await desktop.serverList();
  await list.getByRole("button", { name: /with your browser/ }).click();
  await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
  const link = new URL(await browserApproves((await desktop.recorded()).opened[0] ?? ""));
  link.searchParams.set("server", "https://evil.example.com");
  await desktop.openLink(link.href);
  await expect
    .poll(async () => (await desktop.recorded()).dialogs.at(-1))
    .toMatch(/came from https:\/\/evil\.example\.com/);

  await expect(page).toHaveURL(/\/login/);
  const log = (await (await fetch(`${run.fake}/__fake/log`)).json()) as HandoffEvent[];
  expect(log.filter((event) => event.step === "finish" && event.detail === link.searchParams.get("state"))).toEqual([]);
});

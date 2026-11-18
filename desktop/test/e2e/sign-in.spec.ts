import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { attackersCode, Desktop, expect, signInWithPassword, stillRedeemable, test } from "./desktop";
import type { HandoffEvent } from "./handoff-fake";
import { OWNER, type Run } from "./run";

test("signing in with a password in the server's window opens the workspace", async ({ desktop, run }) => {
  const page = await desktop.addServer(run.server);
  await signInWithPassword(page);
  await expect(page.getByRole("navigation").first()).toBeVisible();
});

/**
 * Plays the system browser's part: opens the connect address the app sent it
 * to, approves, and gives the quadit:// link the browser is sent back with.
 * The stand-in approves at once; a real server shows its page, where a
 * browser signed in as the owner presses Continue.
 */
async function browserApproves(run: Run, connect: string): Promise<string> {
  if (run.server === run.fake) {
    const answer = await fetch(connect, { redirect: "manual" });
    expect(answer.status).toBe(302);
    return answer.headers.get("location") ?? "";
  }
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: run.session.name, value: run.session.value, url: run.server, httpOnly: true }]);
    const page = await context.newPage();
    let link = "";
    // The browser cannot follow a quadit:// redirect here: take it off the answer to Continue.
    await page.route(
      (url) => url.pathname === "/desktop/connect",
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const answer = await route.fetch({ maxRedirects: 0 });
        link = answer.headers()["location"] ?? "";
        await route.fulfill({ status: 200, contentType: "text/plain", body: "Handed to the app." });
      },
    );
    await page.goto(connect);
    await expect(page.getByText(`Sign in to the Quadit app on this computer as ${OWNER.name}?`)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => link).toMatch(/^quadit:\/\/connect\?/);
    return link;
  } finally {
    await browser.close();
  }
}

test("signing in through the browser: the bar on the sign-in page starts it, the quadit:// link finishes it", async ({
  desktop,
  run,
}) => {
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);

  // The bar over the sign-in page is the app's own page, in the same window.
  const bar = await desktop.signInBar();
  await expect.poll(() => desktop.overlayShown(run.server)).toBe(true);
  await bar.getByRole("button", { name: "Sign in with your browser" }).click();

  // The system browser is sent to the server's connect page with a state and an S256 challenge.
  await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
  const connect = new URL((await desktop.recorded()).opened[0] ?? "");
  expect(connect.origin + connect.pathname).toBe(`${run.server}/desktop/connect`);
  expect(connect.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(connect.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const link = await browserApproves(run, connect.href);
  expect(link).toMatch(/^quadit:\/\/connect\?/);
  expect(new URL(link).searchParams.get("state")).toBe(connect.searchParams.get("state"));
  await desktop.openLink(link);

  // The window redeemed the code with the verifier, and is signed in.
  await expect(page).toHaveURL(/\/e2e(\/|$)/);
  await expect(page.getByRole("navigation").first()).toBeVisible();
  // The bar is gone with the sign-in page.
  await expect.poll(() => desktop.overlayShown(run.server)).toBe(false);
  if (run.server !== run.fake) return;
  // The stand-in checked the verifier against the challenge for this state.
  const finished = async () =>
    ((await (await fetch(`${run.fake}/__fake/log`)).json()) as HandoffEvent[]).filter(
      (event) => event.step === "finish",
    );
  await expect.poll(finished).toEqual([{ step: "finish", ok: true, detail: connect.searchParams.get("state") }]);
});

test("a quadit://connect link the app did not start, or for another server, is refused", async ({ desktop, run }) => {
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);

  // A link made by someone else: a state this app never made.
  const challenge = createHash("sha256").update("x".repeat(43)).digest("base64url");
  const forged = await browserApproves(
    run,
    `${run.server}/desktop/connect?state=${"A".repeat(43)}&challenge=${challenge}`,
  );
  await desktop.openLink(forged);
  await expect
    .poll(async () => (await desktop.recorded()).dialogs)
    .toEqual([expect.stringMatching(/was not started from this app/)]);

  // A real flow, but the link names another server.
  const list = await desktop.serverList();
  await list.getByRole("button", { name: /with your browser/ }).click();
  await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
  const link = new URL(await browserApproves(run, (await desktop.recorded()).opened[0] ?? ""));
  link.searchParams.set("server", "https://evil.example.com");
  await desktop.openLink(link.href);
  await expect
    .poll(async () => (await desktop.recorded()).dialogs.at(-1))
    .toMatch(/came from https:\/\/evil\.example\.com/);

  // Neither code was redeemed: the window is still at the sign-in page.
  await expect(page).toHaveURL(/\/login/);
  if (run.server !== run.fake) return;
  const log = (await (await fetch(`${run.fake}/__fake/log`)).json()) as HandoffEvent[];
  expect(log.filter((event) => event.step === "finish" && event.detail === link.searchParams.get("state"))).toEqual([]);
});

/** A quadit://open link whose path is the page that finishes a sign-in, with someone else's code: login CSRF if followed. */
function finishLink(run: Run, code: string, verifier: string): string {
  const path = `/desktop/finish?${new URLSearchParams({ code, verifier })}`;
  return `quadit://open?server=${encodeURIComponent(run.server)}&path=${encodeURIComponent(path)}`;
}

test("a quadit://open link to the sign-in finish does not sign in the app that it starts", async ({ run }) => {
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  let desktop = await Desktop.launch(data, run);
  await expect(await desktop.addServer(run.server)).toHaveURL(/\/login/);
  await desktop.close();

  // The attacker's link starts the app: its window is still loading when the link is read.
  const { code, verifier } = await attackersCode(run);
  desktop = await Desktop.launch(data, run, [finishLink(run, code, verifier)]);
  try {
    const page = await desktop.pageOf(run.server);
    await expect(page).toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle");
    expect(page.url()).toMatch(/\/login/);
    expect(await stillRedeemable(run, code, verifier)).toBe(true);
  } finally {
    await desktop.close();
  }
});

test("nothing but the app's own hand-off reaches the sign-in finish: not a link, a notification or the page", async ({
  desktop,
  run,
}) => {
  const page = await desktop.addServer(run.server);
  await expect(page).toHaveURL(/\/login/);
  const { code, verifier } = await attackersCode(run);
  const finish = `/desktop/finish?${new URLSearchParams({ code, verifier })}`;

  // A link, while the app runs.
  await desktop.openLink(finishLink(run, code, verifier));
  // A notification pointing there.
  await desktop.hide(run.server);
  await page.evaluate((path) => window.quaditDesktop?.notify({ title: "t", body: "b", path }), finish);
  await expect.poll(async () => (await desktop.recorded()).notes.length).toBe(1);
  await desktop.clickLastNotification();
  // The page itself going there, and a window it opens.
  await page.evaluate((path) => (location.href = path), finish);
  await page.evaluate((path) => window.open(path, "_blank"), finish);

  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => location.pathname)).toBe("/login");
  expect(desktop.app.windows().some((p) => p.url().startsWith(`${run.server}/desktop`))).toBe(false);
  // Nor is it handed to the system browser: it is no page for anyone but the app's hand-off.
  expect((await desktop.recorded()).opened).toEqual([]);
  expect(await stillRedeemable(run, code, verifier)).toBe(true);
});

test("a link to a server not added yet still opens its page once the server is added and signed in to", async ({
  desktop,
  run,
}) => {
  // Add It… on the app's question about the server it is not connected to.
  await desktop.answerNextDialog(0);
  await desktop.openLink(
    `quadit://open?server=${encodeURIComponent(run.server)}&path=${encodeURIComponent("/e2e/inbox")}`,
  );
  const list = await desktop.serverList();
  await expect(list.getByRole("status")).toHaveText(/A link asked to open/);
  await list.getByRole("button", { name: "Add server" }).click();

  // Signed out, the web app keeps the page for after its sign-in page.
  const page = await desktop.pageOf(run.server);
  await expect(page).toHaveURL(`${run.server}/login?next=%2Fe2e%2Finbox`);

  // Signed in through the browser, the window goes on to it.
  await expect.poll(() => desktop.overlayShown(run.server)).toBe(true);
  await (await desktop.signInBar()).getByRole("button", { name: "Sign in with your browser" }).click();
  await expect.poll(async () => (await desktop.recorded()).opened.length).toBe(1);
  await desktop.openLink(await browserApproves(run, (await desktop.recorded()).opened[0] ?? ""));
  await expect(page).toHaveURL(`${run.server}/e2e/inbox`);
});

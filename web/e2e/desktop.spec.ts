// The browser's part of signing the desktop app in: the app opens
// /desktop/connect in the system browser, the person signs in there and
// presses Continue, and the browser is sent to quadit://connect with a code.
// Playwright cannot follow that link, so the test reads where the server
// sent the browser, and does what the app does with it: opens
// /desktop/finish in a window of its own, which comes out signed in.

import { createHash, randomBytes } from "node:crypto";
import { currentRun, OWNER } from "./run";
import { expect, test } from "./quadit";

// Signed out to begin with: the page must send the person through the sign-in page and back.
test.use({ storageState: { cookies: [], origins: [] } });

/** A flow as the app starts one: its state, and the verifier with its S256 challenge. */
function newFlow() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

test("a browser signed out signs in, confirms, and the app's window comes out signed in", async ({ page, browser }) => {
  const flow = newFlow();
  // A policy of the page refusing where Continue goes would show here; the server's redirect alone cannot.
  const refusals: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("Content Security Policy")) refusals.push(msg.text());
  });

  await page.goto(`/desktop/connect?state=${flow.state}&challenge=${flow.challenge}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: `Sign in to the Quadit app on this computer as ${OWNER.name}?` }),
  ).toBeVisible();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/desktop/connect"));
  await page.getByRole("button", { name: "Continue" }).click();
  const answer = await answered;
  expect(answer.status()).toBe(303);
  const link = new URL(answer.headers()["location"] ?? "");
  expect(link.protocol).toBe("quadit:");
  expect(link.host).toBe("connect");
  expect(link.searchParams.get("server")).toBe(currentRun().url);
  expect(link.searchParams.get("state")).toBe(flow.state);
  const code = link.searchParams.get("code") ?? "";
  expect(code).not.toBe("");
  await expect(page.getByText("Your browser asks to open the Quadit app")).toBeVisible();
  expect(refusals).toEqual([]);

  // The app's window: a browser of its own, signed in by nothing but the code and the verifier.
  const app = await browser.newContext({
    baseURL: currentRun().url,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    userAgent: `${await page.evaluate(() => navigator.userAgent)} QuaditDesktop/0.1.0`,
  });
  const window = await app.newPage();
  await window.goto(`/desktop/finish?code=${code}&verifier=${flow.verifier}`);
  await expect(window.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();

  // The code is spent: a second window gets the plain page, not a session.
  const again = await (await browser.newContext({ baseURL: currentRun().url, serviceWorkers: "block" })).newPage();
  await again.goto(`/desktop/finish?code=${code}&verifier=${flow.verifier}`);
  await expect(again.getByRole("heading", { level: 1, name: "Signing in to the app did not work" })).toBeVisible();
  await app.close();
  await again.context().close();
});

test("a page loaded as the sign-in page hands over too", async ({ page }) => {
  // How a browser comes back from a provider that still wants the second step: the page was loaded at /login.
  const flow = newFlow();
  const refusals: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("Content Security Policy")) refusals.push(msg.text());
  });
  await page.goto(
    `/login?next=${encodeURIComponent(`/desktop/connect?state=${flow.state}&challenge=${flow.challenge}`)}`,
  );
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/desktop/connect"));
  await page.getByRole("button", { name: "Continue" }).click();
  expect(new URL((await answered).headers()["location"] ?? "").protocol).toBe("quadit:");
  expect(refusals).toEqual([]);
});

test("cancel signs nothing in", async ({ page }) => {
  const flow = newFlow();
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();

  let posted = false;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/desktop/connect")) posted = true;
  });
  await page.goto(`/desktop/connect?state=${flow.state}&challenge=${flow.challenge}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cancelled" })).toBeVisible();
  expect(posted).toBe(false);
});

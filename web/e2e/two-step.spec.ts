// Two-step verification required by the install: what lets a person in is
// how this sign-in went, not what their account has set up. A password is
// one step; a person with a passkey confirms with it next, a person with an
// authenticator app types its code. The setting holds for the whole
// install, so these tests run on a server of their own.

import { createHmac } from "node:crypto";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { OWNER, WORKSPACE } from "./run";
import { type Server, startServer } from "./server";

let server: Server;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startServer("localhost");
});

test.afterAll(async ({}, testInfo) => {
  await server?.stop(testInfo.outputDir);
});

/** A browser of its own, signed in as nobody, with a passkey device that says yes. */
async function freshBrowser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: server.url, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { context, page };
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The six-digit code an authenticator app shows now for a base32 secret (RFC 6238). */
function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const at = (mac[mac.length - 1] ?? 0) & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("a password sign-in is followed by the second step the person has", async ({ browser }) => {
  const { context, page } = await freshBrowser(browser);
  const member = { email: "mia@example.com", password: "a-long-member-password", secret: "" };

  await test.step("the first person adds a passkey and requires two steps of everyone", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Your name").fill(OWNER.name);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByLabel("Workspace name").fill(WORKSPACE.name);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE.slug}(/|$)`));
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const required = await page.request.put("/api/v1/admin/settings/auth.require_2fa", { data: true });
    expect(required.ok()).toBe(true);
  });

  await test.step("a member sets up an authenticator app", async () => {
    const invite = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/invites`, { data: { role: "member" } });
    expect(invite.ok()).toBe(true);
    const { link } = (await invite.json()) as { link: string };
    const joining = await browser.newContext({ baseURL: server.url });
    const accepted = await joining.request.post(`/api/v1/auth/invite/${link.slice(link.lastIndexOf("/") + 1)}`, {
      data: { name: "Mia", email: member.email, password: member.password },
    });
    expect(accepted.ok()).toBe(true);
    const start = await joining.request.post("/api/v1/auth/totp/start", { data: {} });
    const { secret } = (await start.json()) as { secret: string };
    const enabled = await joining.request.post("/api/v1/auth/totp/enable", { data: { code: totp(secret) } });
    expect(enabled.ok()).toBe(true);
    member.secret = secret;
    await joining.close();
  });

  await test.step("the password of a person with a passkey is followed by the passkey", async () => {
    await page.request.post("/api/v1/auth/logout");
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "One more step" })).toBeVisible();
    await expect(page.getByText("Confirm it is you with your passkey.")).toBeVisible();
    await expect(page.getByLabel("Code")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
  });

  await test.step("the password of a person with an app is followed by its code", async () => {
    const { context: other, page: second } = await freshBrowser(browser);
    await signInWithPassword(second, member.email, member.password);
    await expect(second.getByRole("heading", { name: "One more step" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Sign in with a passkey" })).toHaveCount(0);
    await second.getByLabel("Code").fill(totp(member.secret));
    await expect(second.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
    await other.close();
  });
  await context.close();
});

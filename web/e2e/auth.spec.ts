import { OWNER } from "./run";
import { expect, test } from "./quadit";

// Signed out to begin with: signing out here must not end the session the other tests share.
test.use({ storageState: { cookies: [], origins: [] } });

test("signs in with the password and out again", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/e2e/my-work");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(/wrong email or password/i);
  await expect(page).toHaveURL(/\/login/);
});

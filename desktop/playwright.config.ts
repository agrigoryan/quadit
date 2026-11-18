// The desktop end-to-end suite: Playwright drives the Electron app (built
// into out/ by `pnpm e2e`) against a real Quadit server the global set-up
// starts. One app at a time: each test starts its own.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
});

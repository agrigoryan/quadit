// The end-to-end suite: Chromium against the real binary. The global set-up
// (e2e/global-setup.ts) starts a server of its own for each run; see the
// README's "End-to-end tests". Run: make e2e, or pnpm e2e after make build.

import { defineConfig, devices } from "@playwright/test";

const ci = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
    // The app's service worker would answer from its cache; the tests want the server.
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", testIgnore: /bfcache\.spec\.ts/ },
    {
      // Chromium with its back/forward cache, which Playwright turns off by
      // default. The headless shell has none; Chromium's new headless mode
      // (channel "chromium") has it, headed or not.
      name: "chromium-bfcache",
      testMatch: /bfcache\.spec\.ts/,
      use: { channel: "chromium", launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } },
    },
  ],
});

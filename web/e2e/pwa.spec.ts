// The installed web app (public/manifest.webmanifest): opening it again
// brings the window it has open forward, and its shortcuts open the pages
// they name. Offline, its service worker (public/sw.js) shows the page it
// kept.

import { expect, test } from "./quadit";

interface Manifest {
  launch_handler?: { client_mode?: string };
  shortcuts?: { name: string; url: string }[];
}

test("the installed app reuses its open window, and its shortcuts open My work and the inbox", async ({
  page,
  request,
}) => {
  const manifest = (await (await request.get("/manifest.webmanifest")).json()) as Manifest;
  expect(manifest.launch_handler?.client_mode).toBe("navigate-existing");
  const shortcuts = manifest.shortcuts ?? [];
  expect(shortcuts.map((s) => s.name)).toEqual(["My work", "Inbox"]);
  for (const shortcut of shortcuts) {
    await page.goto(shortcut.url);
    await expect(page.getByRole("heading", { level: 1, name: shortcut.name })).toBeVisible();
  }
});

// The page that signs the desktop app in, for a flow of the app's (any state and challenge of the right form).
const CONNECT = `/desktop/connect?state=${"s".repeat(16)}&challenge=${"c".repeat(43)}`;

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("the page kept for offline is an ordinary page's, never the desktop sign-in's", async ({ page, context }) => {
    await page.goto("/e2e/my-work");
    await page.evaluate(async () => void (await navigator.serviceWorker.ready));
    // An ordinary page, then the page that signs the desktop app in, both through the worker.
    await page.goto("/e2e/my-work");
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
    await page.goto(CONNECT);
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await context.setOffline(true);
    try {
      // Offline, the app's pages come from the kept copy, with the ordinary page's policy: its forms post to the server alone.
      const kept = await page.goto("/e2e/inbox");
      expect(kept?.headers()["content-security-policy"]).toMatch(/form-action 'self'(;|$)/);
      // The desktop sign-in is never answered from a kept copy, whose policy would not be its own.
      await expect(page.goto(CONNECT)).rejects.toThrow();
    } finally {
      await context.setOffline(false);
    }
  });
});

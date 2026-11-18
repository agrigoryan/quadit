// The installed web app (public/manifest.webmanifest): opening it again
// brings the window it has open forward, and its shortcuts open the pages
// they name.

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

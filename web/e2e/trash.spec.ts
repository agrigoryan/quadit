// A task in the trash or the archive: the trash lists it and brings it back
// (and a list or the page tree open elsewhere shows what came back), its
// own page says where it is, and no list, board or search shows it. The
// lists are open when the task goes, so the row the live feed changes is the
// one that must disappear.

import type { Page } from "@playwright/test";
import { expect, type Project, type Quadit, test } from "./quadit";

const trash = (quadit: Quadit, key: string) => quadit.cli("do", "task.delete", JSON.stringify({ id: key }));
const archive = (quadit: Quadit, key: string) =>
  quadit.cli("do", "task.update", JSON.stringify({ id: key, archived: true }));

test("the trash lists a trashed task and restores it", async ({ page, project, quadit }) => {
  const key = await project.newTask("Retire the old mailer");
  await trash(quadit, key);
  await page.goto("/e2e/trash");
  await page.getByRole("button", { name: `Restore ${key}` }).click();
  await expect(page.getByRole("button", { name: `Restore ${key}` })).toBeHidden();
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
});

test("a task brought back from the trash elsewhere appears in the open list without a reload", async ({
  page,
  project,
  quadit,
}) => {
  const stays = await project.newTask("Keep the new logo");
  const key = await project.newTask("Bring back the old logo");
  await trash(quadit, key);
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${stays}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeHidden();
  await quadit.cli("do", "task.restore", JSON.stringify({ id: key }));
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
});

test("a page brought back from the trash elsewhere appears in the open page tree without a reload", async ({
  page,
  project,
  quadit,
}) => {
  const title = `Old handbook ${project.key}`;
  const id = (JSON.parse(await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title }))) as { ref: string })
    .ref;
  await quadit.cli("do", "doc.create", JSON.stringify({ title: `New handbook ${project.key}` }));
  await quadit.cli("do", "doc.delete", JSON.stringify({ id }));
  await page.goto("/e2e/docs");
  const tree = page.getByRole("navigation", { name: "Pages" });
  await expect(tree.getByRole("link", { name: `New handbook ${project.key}` })).toBeVisible();
  await expect(tree.getByRole("link", { name: title })).toHaveCount(0);
  await quadit.cli("do", "doc.restore", JSON.stringify({ id }));
  await expect(tree.getByRole("link", { name: title })).toBeVisible();
});

test("a trashed task's own page opens and says it is in the trash", async ({ page, project, quadit }) => {
  const key = await project.newTask("Drop the beta banner");
  await trash(quadit, key);
  await page.goto(`/e2e/task/${key}`);
  await expect(page.getByText("This task is in the trash.")).toBeVisible();
  // Its title is words to read, not a box to Tab into.
  await expect(page.getByRole("heading", { level: 2, name: "Drop the beta banner" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
});

test("a trashed task leaves the list, the board, My work and the palette", async ({ page, project, quadit }) => {
  await expectGoneEverywhere(page, project, (key) => trash(quadit, key));
});

test("an archived task leaves the list, the board, My work and the palette", async ({ page, project, quadit }) => {
  await expectGoneEverywhere(page, project, (key) => archive(quadit, key));
});

/** Two tasks of mine, one of which `put` takes away while its list is open: from then on only the other shows. */
async function expectGoneEverywhere(page: Page, project: Project, put: (key: string) => Promise<unknown>) {
  const stays = await project.newTask(`Quokka ${project.key} stays`, "assignee=@ann-owner");
  const goes = await project.newTask(`Quokka ${project.key} goes`, "assignee=@ann-owner");

  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${goes}` })).toBeVisible();
  await put(goes);
  await expect(page.getByRole("link", { name: `Open ${goes}` })).toBeHidden();
  await expect(page.getByRole("link", { name: `Open ${stays}` })).toBeVisible();

  await page.goto(`/e2e/p/${project.key}/board`);
  await expect(page.getByRole("link", { name: new RegExp(`${stays} Quokka`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`${goes} Quokka`) })).toBeHidden();

  await page.goto("/e2e/my-work");
  await expect(page.getByRole("link", { name: `Open ${stays}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${goes}` })).toBeHidden();

  await expectPaletteFinds(page, project, stays, goes);
}

/** The palette, searched for the project's two tasks, offers the first and not the second. */
async function expectPaletteFinds(page: Page, project: Project, found: string, notFound: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Command palette" }).fill(`Quokka ${project.key}`);
  await expect(palette.getByRole("option", { name: new RegExp(found) })).toBeVisible();
  await expect(palette.getByRole("option", { name: new RegExp(notFound) })).toHaveCount(0);
}

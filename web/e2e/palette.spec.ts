import { expect, test } from "./quadit";

test("Cmd/Ctrl+K finds a task by its title and opens it", async ({ page, project }) => {
  const key = await project.newTask("Renew the certificate");
  await page.goto("/e2e/my-work");
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByRole("combobox", { name: "Command palette" });
  await expect(search).toBeFocused();
  await search.fill("Renew the cert");
  // Other tests' projects may hold a task of the same title: this project's is the one.
  await palette.getByRole("option", { name: new RegExp(`${key}.*Renew the certificate`) }).click();

  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Renew the certificate");
});

test("the open task moved to another project from the palette stays open under its new key", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Port the importer");
  const other = `${project.key}X`;
  await quadit.cli("do", "project.create", JSON.stringify({ key: other, name: `Elsewhere ${other}` }));
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await expect(page.getByRole("link", { name: `Open ${key}` })).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(page.getByRole("complementary", { name: key })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Command palette" }).fill("move to project");
  await palette.getByRole("option", { name: "Move to project…" }).click();
  await palette.getByRole("option", { name: new RegExp(`Elsewhere ${other}`) }).click();
  await expect.poll(async () => (await quadit.task(key)).key).toBe(`${other}-1`);

  // Still the panel over the list, now under the task's new key.
  const panel = page.getByRole("complementary", { name: `${other}-1` });
  await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Port the importer");
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${other}-1$`));
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
});

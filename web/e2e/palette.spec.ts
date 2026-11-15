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

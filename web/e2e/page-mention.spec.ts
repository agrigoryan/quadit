import { expect, type Quadit, test } from "./quadit";

/** Makes a page through the CLI and gives its id. */
async function newPage(quadit: Quadit, title: string, project: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown: "What we found.\n" })),
  ) as { ref: string };
  return made.ref;
}

// A page an agent links in a comment as [Title](doc:ID) shows as the page,
// under the title it has now, and opens inside the app; one in the trash is
// the words written, with nothing to click.
test("a page linked in a comment shows its title as it is now and opens the page", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Meta rework");
  const review = await newPage(quadit, `Review ${project.key}`, project.key);
  const old = await newPage(quadit, `Old plan ${project.key}`, project.key);
  await quadit.cli("do", "doc.delete", JSON.stringify({ id: old }));
  await quadit.agent("comment", key, `The page is [Review](doc:${review}); not [the old plan](doc:${old}).`);

  await page.goto(`/e2e/task/${key}`);
  const comment = page
    .getByRole("region", { name: "Activity" })
    .getByRole("listitem")
    .filter({ hasText: "The page is" });
  const mention = comment.getByRole("link", { name: `Review ${project.key}` });
  await expect(mention).toBeVisible();
  await expect(comment.getByText("the old plan")).toBeVisible();
  await expect(comment.getByRole("link", { name: /old plan/ })).toHaveCount(0);

  // Renamed elsewhere, the mention follows.
  await quadit.cli("do", "doc.update", JSON.stringify({ id: review, title: `Final review ${project.key}` }));
  const renamed = comment.getByRole("link", { name: `Final review ${project.key}` });
  await expect(renamed).toBeVisible();

  await renamed.click();
  await expect(page).toHaveURL(new RegExp(`/e2e/docs/${review}$`));
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(`Final review ${project.key}`);
});

// Typing [[ in the comment box offers the pages by title; the one picked is
// written as the link to it, which the comment then shows as the page.
test("[[ in the comment box offers the pages and writes the link to the one picked", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Meta rework");
  const review = await newPage(quadit, `Rework notes ${project.key}`, project.key);

  await page.goto(`/e2e/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  const box = activity.getByRole("textbox", { name: "New comment" });
  await box.pressSequentially(`Read [[rework notes ${project.key}`);
  const offered = page.getByRole("listbox").getByRole("option", { name: `Rework notes ${project.key}` });
  await expect(offered).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue(`Read [Rework notes ${project.key}](doc:${review})`);

  await activity.getByRole("button", { name: "Send" }).click();
  const comment = activity.getByRole("listitem").filter({ hasText: "Read" });
  await expect(comment.getByRole("link", { name: `Rework notes ${project.key}` })).toBeVisible();
  await expect
    .poll(async () => (await quadit.cli("show", key)).includes(`[Rework notes ${project.key}](doc:${review})`))
    .toBe(true);
});

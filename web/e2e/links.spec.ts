import { expect, test } from "./quadit";

// A member named in a page opens the card about them, from the keyboard as
// the other chips open what they name (Mod-Enter beside it while editing),
// and the card leads to the tasks they have in the project.
test("a member's mention in a page opens the card about them by keyboard, and it leads to their tasks", async ({
  page,
  project,
  quadit,
}) => {
  await project.newTask(`Paint the boss ${project.key}`, "assignee=@coder");
  await project.newTask(`Write the music ${project.key}`);
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title: "Art notes", project: project.key })),
  ) as { ref: string };

  await page.goto(`/e2e/p/${project.key}/docs/${made.ref}`);
  await page.getByRole("textbox", { name: "Page text" }).click();
  await page.keyboard.type("Ask @cod");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "About Coder" })).toBeVisible();

  // The caret goes to the end, after the space that follows the chip: one step back, and it is beside it.
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+Enter");
  const card = page.getByRole("dialog", { name: "Coder" });
  await expect(card).toBeVisible();
  await expect(card.getByText("@coder · Agent")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // The focus is back in the text.
  await expect(page.getByRole("textbox", { name: "Page text" })).toBeFocused();

  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+Enter");
  await card.getByRole("link", { name: /Tasks assigned/ }).click();
  await expect(page).toHaveURL(new RegExp(`/e2e/p/${project.key}/tasks\\?assignee=%40coder$`));
  const list = page.getByRole("main");
  await expect(list.getByText(`Paint the boss ${project.key}`)).toBeVisible();
  await expect(list.getByText(`Write the music ${project.key}`)).toBeHidden();
});

// The list of members to mention plays its way out for a moment after a
// pick; the keys pressed meanwhile are the text's: Enter starts a new line,
// it does not pick again.
test("the keys pressed right after picking a member to mention go to the text", async ({ page, project, quadit }) => {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title: "Notes", project: project.key })),
  ) as { ref: string };
  await page.goto(`/e2e/p/${project.key}/docs/${made.ref}`);
  const text = page.getByRole("textbox", { name: "Page text" });
  await text.click();
  await page.keyboard.type("Ask @cod");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Next line");
  await expect(text.getByText("Next line")).toBeVisible();
  await expect(text.getByRole("button", { name: "About Coder" })).toHaveCount(1);
  await expect.poll(() => quadit.cli("doc", made.ref)).toMatch(/Ask @coder\s*\n+\s*Next line/i);
});

// A task and a page point at each other: a page linked from the task with
// its picker lists the task, and the link taken off on the page is gone from
// the task too.
test("a page linked from a task lists the task, and taking the link off there takes it off the task", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Boss fight");
  const other = await project.newTask("Arena lighting");
  const title = `Boss fight spec ${project.key}`;
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project: project.key })),
  ) as { ref: string };

  await page.goto(`/e2e/task/${key}`);
  await page.getByRole("button", { name: "Page", exact: true }).click();
  await page.getByPlaceholder("Search pages by title").fill(title);
  await page.keyboard.press("Enter");
  const pages = page.getByRole("region", { name: "Pages" });
  await expect(pages.getByRole("link", { name: title })).toBeVisible();
  await expect.poll(() => quadit.cli("show", key)).toContain(`page ${title}`);

  await pages.getByRole("link", { name: title }).click();
  const tasks = page.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByRole("link", { name: "Boss fight", exact: true })).toBeVisible();

  // Someone else links a task the page has not seen, and takes it off again: the open page follows.
  const linked = JSON.parse(await quadit.agent("--json", "link", other, `page=${made.ref}`)) as { ref: string };
  await expect(tasks.getByRole("link", { name: "Arena lighting" })).toBeVisible();
  await quadit.agent("do", "link.remove", JSON.stringify({ id: linked.ref }));
  await expect(tasks.getByRole("link", { name: "Arena lighting" })).toBeHidden();

  await tasks.getByRole("button", { name: `Remove the link to ${key}` }).click();
  await expect(tasks.getByRole("link", { name: "Boss fight", exact: true })).toBeHidden();
  await expect.poll(() => quadit.cli("show", key)).not.toContain(`page ${title}`);

  await page.goto(`/e2e/task/${key}`);
  // Its history says the page was linked; the page is no longer among its pages.
  await expect(page.getByRole("region", { name: "Activity" }).getByText(`linked the page ${title}`)).toBeVisible();
  await expect(page.getByRole("region", { name: "Pages" })).toBeHidden();
});

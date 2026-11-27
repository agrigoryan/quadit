// The @ list of a comment box: people, tasks and pages in one list, each
// under its heading, a few of each with a row for the rest; what picking
// each writes, and how the comment then shows it. Seeding and checking go
// through the CLI.

import type { Page } from "@playwright/test";
import { expect, type Quadit, test } from "./quadit";

/** Makes a page in the project through the CLI and gives its id. */
async function newPage(quadit: Quadit, title: string, project: string) {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title, project, markdown: "Notes.\n" })),
  ) as { ref: string };
  return made.ref;
}

const section = (page: Page, name: string) => page.getByRole("listbox").getByRole("group", { name });

test("@ and a word offers a person, a task and a page in their sections, and each picked shows in the comment", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Paint the fence");
  const other = await project.newTask(`Coder rework ${project.key}`);
  const guide = await newPage(quadit, `Coder guide ${project.key}`, project.key);

  await page.goto(`/e2e/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  const box = activity.getByRole("textbox", { name: "New comment" });
  await box.pressSequentially("Ask @coder");
  await expect(section(page, "People").getByRole("option", { name: /Coder.*@coder/ })).toBeVisible();
  await expect(
    section(page, "Tasks").getByRole("option", { name: `${other} Coder rework ${project.key}` }),
  ).toBeVisible();
  await expect(
    section(page, "Pages").getByRole("option", { name: new RegExp(`Coder guide ${project.key}`) }),
  ).toBeVisible();
  // The person comes first, and Enter picks them.
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("Ask @coder ");

  await box.pressSequentially("about @coder");
  await section(page, "Tasks")
    .getByRole("option", { name: `${other} Coder rework ${project.key}` })
    .click();
  await box.pressSequentially("and @coder");
  await section(page, "Pages")
    .getByRole("option", { name: new RegExp(`Coder guide ${project.key}`) })
    .click();
  await expect(box).toHaveValue(`Ask @coder about ${other} and [Coder guide ${project.key}](doc:${guide}) `);
  await expect(page.getByRole("listbox")).toBeHidden();

  await activity.getByRole("button", { name: "Send" }).click();
  const comment = activity.getByRole("listitem").filter({ hasText: "Ask" });
  await expect(comment.getByRole("link", { name: new RegExp(`${other} Coder rework`) })).toBeVisible();
  await expect(comment.getByRole("link", { name: `Coder guide ${project.key}` })).toBeVisible();
  await expect
    .poll(async () => (await quadit.cli("show", key)).includes(`Ask @coder about ${other} and [Coder guide`))
    .toBe(true);
});

test("a section shows five and how many more, and picking that shows the rest of it alone", async ({
  page,
  project,
}) => {
  const key = await project.newTask("First");
  for (let i = 2; i <= 7; i++) await project.newTask(`Step ${i}`);

  await page.goto(`/e2e/task/${key}`);
  const box = page.getByRole("region", { name: "Activity" }).getByRole("textbox", { name: "New comment" });
  // The project's key is in every one of its tasks' keys, and in nothing else.
  await box.pressSequentially(`@${project.key.toLowerCase()}`);
  const tasks = section(page, "Tasks");
  await expect(tasks.getByRole("option")).toHaveCount(6);
  await tasks.getByRole("option", { name: "2 more" }).click();
  await expect(page.getByRole("listbox").getByRole("group")).toHaveCount(1);
  await expect(tasks.getByRole("option")).toHaveCount(7);
  await expect(box).toBeFocused();
  await tasks.getByRole("option", { name: `${key} First` }).click();
  await expect(box).toHaveValue(`${key} `);
});

test("the task's comment box has the paperclip, @ and the send arrow, and @ opens the list", async ({
  page,
  project,
}) => {
  const key = await project.newTask("Choose a logo");
  await page.goto(`/e2e/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  const box = activity.getByRole("textbox", { name: "New comment" });
  await expect(activity.getByRole("button", { name: "Then hand to…" })).toBeVisible();
  await expect(activity.getByRole("button", { name: "Attach files" })).toBeVisible();
  await expect(activity.getByRole("button", { name: "Send" })).toBeDisabled();

  const mention = activity.getByRole("button", { name: "Mention a person, task or page" });
  await mention.hover();
  await expect(page.getByRole("tooltip", { name: "Mention a person, task or page" })).toBeVisible();
  await box.fill("Ask");
  await mention.click();
  await expect(box).toHaveValue("Ask @");
  await expect(box).toBeFocused();
  // With nothing typed yet: the people first (which five depends on who else the run made), then the project's tasks.
  await expect(section(page, "People").getByRole("option").first()).toBeVisible();
  await expect(section(page, "Tasks").getByRole("option", { name: `${key} Choose a logo` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await box.pressSequentially(" no one");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(activity.getByRole("listitem").filter({ hasText: "Ask @ no one" })).toBeVisible();
});

test("@ in a page's comment offers the tasks too, and a task picked shows in the thread", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask(`Coder rework ${project.key}`);
  const doc = await newPage(quadit, `Roadmap ${project.key}`, project.key);

  await page.goto(`/e2e/docs/${doc}`);
  await page.getByRole("button", { name: "Comments" }).click();
  const column = page.getByRole("complementary", { name: "Comments" });
  const box = column.getByRole("textbox", { name: "Comment on the page…" });
  await box.click();
  await column.getByRole("button", { name: "Mention a person, task or page" }).click();
  await box.pressSequentially("coder");
  await expect(section(page, "People").getByRole("option", { name: /Coder.*@coder/ })).toBeVisible();
  await section(page, "Tasks")
    .getByRole("option", { name: `${key} Coder rework ${project.key}` })
    .click();
  await expect(box).toHaveValue(`${key} `);
  await column.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(
    column.getByRole("article").getByRole("link", { name: new RegExp(`${key} Coder rework`) }),
  ).toBeVisible();
});

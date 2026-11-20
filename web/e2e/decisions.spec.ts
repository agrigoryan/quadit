import { writeFile } from "node:fs/promises";
import { OWNER } from "./run";
import { expect, test } from "./quadit";

/** A decision as `quadit --json show` gives it. */
interface Decision {
  state: string;
  picked_label?: string;
  decided_by?: string;
}

test("an agent's question is answered in the app and the answer is recorded", async ({ page, project, quadit }) => {
  const key = await project.newTask("Pick a colour scheme");
  await quadit.agent("ask", key, "Which colour?", "option=Blue", "option=Green", `ask=@${OWNER.handle}`);

  await page.goto(`/e2e/task/${key}`);
  const question = page.getByRole("region", { name: "Decisions" }).getByRole("article", { name: "Which colour?" });
  await expect(question.getByText("Your answer is needed")).toBeVisible();
  await question.getByRole("article", { name: "Green" }).getByRole("button", { name: "This one", exact: true }).click();
  await expect(question.getByText("Your answer is needed")).toBeHidden();

  await expect
    .poll(async () => (JSON.parse(await quadit.agent("--json", "show", key)) as { decisions: Decision[] }).decisions[0])
    .toMatchObject({ state: "picked", picked_label: "Green", decided_by: `@${OWNER.handle}` });
});

test("an option's picture opens alone, steps to the next option, and switches to side by side", async ({
  page,
  project,
  quadit,
}, testInfo) => {
  const key = await project.newTask("Pick a logo");
  // A one-pixel picture on each option.
  const pixel = testInfo.outputPath("pixel.png");
  await writeFile(
    pixel,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await quadit.agent(
    "ask",
    key,
    "Which logo?",
    ...["Round", "Square", "Star"].flatMap((label) => [`option=${label}`, `file=${pixel}`]),
  );

  await page.goto(`/e2e/task/${key}`);
  const question = page.getByRole("article", { name: "Which logo?" });
  await question
    .getByRole("article", { name: "Square" })
    .getByRole("button", { name: "Open Square full screen" })
    .click();

  const stage = page.getByRole("dialog", { name: "Which logo?" });
  const panes = stage.getByRole("region");
  await expect(panes).toHaveCount(1);
  await expect(stage.getByRole("region", { name: "Square" })).toBeVisible();
  await expect(stage.getByText("2 of 3")).toBeVisible();

  await stage.getByRole("button", { name: "Next option" }).click();
  await expect(stage.getByRole("region", { name: "Star" })).toBeVisible();
  await expect(panes).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(stage.getByRole("region", { name: "Square" })).toBeVisible();

  await stage.getByRole("button", { name: "Side by side" }).click();
  await expect(panes).toHaveCount(3);
  await expect(stage.getByRole("button", { name: "Next option" })).toBeHidden();
});

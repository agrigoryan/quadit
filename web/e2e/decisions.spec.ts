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

test("an option's pictures go round on its card, and one at a time walks through every picture, option after option", async ({
  page,
  project,
  quadit,
}, testInfo) => {
  const key = await project.newTask("Pick a logo");
  // One-pixel pictures: one on each option, and a second on "Square".
  const pixel = testInfo.outputPath("pixel.png");
  const other = testInfo.outputPath("other.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(pixel, png);
  await writeFile(other, png);
  await quadit.agent(
    "ask",
    key,
    "Which logo?",
    "option=Round",
    `file=${pixel}`,
    "option=Square",
    `file=${pixel}`,
    `file=${other}`,
    "option=Star",
    `file=${pixel}`,
  );

  await page.goto(`/e2e/task/${key}`);
  const square = page.getByRole("article", { name: "Which logo?" }).getByRole("article", { name: "Square" });
  await expect(square.getByText("1 / 2")).toBeVisible();
  await square.getByRole("button", { name: "Next file" }).click();
  await expect(square.getByText("2 / 2")).toBeVisible();
  await square.getByRole("button", { name: "Next file" }).click();
  await expect(square.getByText("1 / 2")).toBeVisible();
  await square.getByRole("button", { name: "Open Square full screen" }).click();

  const stage = page.getByRole("dialog", { name: "Which logo?" });
  const panes = stage.getByRole("region");
  await expect(panes).toHaveCount(1);
  await expect(stage.getByRole("region", { name: "Square" })).toBeVisible();
  await expect(stage.getByText("Option 2 of 3 · picture 1 of 2")).toBeVisible();

  // Next goes through Square's second picture before it reaches Star.
  await stage.getByRole("button", { name: "Next", exact: true }).click();
  await expect(stage.getByText("Option 2 of 3 · picture 2 of 2")).toBeVisible();
  await stage.getByRole("button", { name: "Next", exact: true }).click();
  await expect(stage.getByRole("region", { name: "Star" })).toBeVisible();
  await expect(stage.getByText("Option 3 of 3")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(stage.getByText("Option 2 of 3 · picture 2 of 2")).toBeVisible();

  await stage.getByRole("button", { name: "Side by side" }).click();
  await expect(panes).toHaveCount(3);
  await expect(stage.getByRole("button", { name: "Next", exact: true })).toBeHidden();
  await expect(stage.getByRole("region", { name: "Square" }).getByText("2 / 2")).toBeVisible();
});

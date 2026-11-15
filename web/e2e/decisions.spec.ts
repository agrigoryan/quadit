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

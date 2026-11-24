// An agent's three states as a person sees them (desktop contract §11): the
// line under the comment box of a task given to an agent says what will
// happen to what is written, an agent that has not connected is connected
// with a code made in Settings and given back with `quadit connect CODE`,
// and the agent that then runs `quadit wait` shows as listening.

import { randomUUID } from "node:crypto";
import { expect, test } from "./quadit";
import { currentRun, fromOwnPage, quadit, WORKSPACE } from "./run";

test("the comment box says what happens to a comment in each of the agent's states, and a code from Settings connects it", async ({
  page,
  project,
  quadit: owner,
}) => {
  // An agent of this test's own, with a token, which has done nothing yet.
  const handle = `codex-${randomUUID().slice(0, 6)}`;
  await owner.cli("do", "agent.create", JSON.stringify({ name: "Codex", handle }));
  const made = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/tokens`, {
    data: { user: `@${handle}` },
    headers: fromOwnPage(currentRun().url),
  });
  expect(made.status()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  const agent = (...args: string[]) => quadit(currentRun(), token, args);

  const key = await project.newTask("Look at the login bug", `assignee=@${handle}`);
  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByText(`@${handle} has not connected yet.`)).toBeVisible();

  // In a browser, the way to connect is the agent's page in Settings.
  await activity.getByRole("link", { name: "Connect it in Settings" }).click();
  await expect(page).toHaveURL(`/${WORKSPACE.slug}/settings/agents/${handle}`);
  await expect(page.getByRole("textbox", { name: "Tool" })).toHaveValue("Codex");
  await page.getByRole("button", { name: "Make a connect code" }).click();
  await expect(page.getByText("In Codex, say:")).toBeVisible();
  const line = (await page.getByRole("code").filter({ hasText: "Connect to Quadit" }).textContent()) ?? "";
  const code = line.replace("Connect to Quadit ", "");
  expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  await expect(page.getByText("Waiting for Codex…")).toBeVisible();

  // The agent gives it back from inside its tool, and the page sees it.
  expect(await agent("connect", code)).toContain(`Connected as @${handle} in the workspace "${WORKSPACE.name}".`);
  await expect(page.getByText("Connected: Codex gave the code back.")).toBeVisible();

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  await expect(
    activity.getByText(
      `@${handle} is not listening. To have it answer here, say “listen to Quadit” in Codex. Until then it sees this when you next ask it, for example “check Quadit”.`,
    ),
  ).toBeVisible();

  // The person asked it to listen: its first wait takes the lease, and starts at the present, so the assignment
  // from before is not handed over again. Nothing in the feed says so: the line is read again while it is shown.
  const waited = await agent("wait", "for=1");
  expect(waited).toMatch(/^IDLE\n/);
  await expect(activity.getByText(`@${handle} is listening and will see this.`)).toBeVisible({ timeout: 30_000 });
});

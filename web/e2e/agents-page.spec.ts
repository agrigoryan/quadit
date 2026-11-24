// The Agents page in a browser: each card offers the one thing a page can do
// about its agent's state, says where it lives, and leads to its settings;
// the header adds an agent with Settings' dialog.

import { randomUUID } from "node:crypto";
import { expect, test } from "./quadit";
import { currentRun, fromOwnPage, quadit, WORKSPACE } from "./run";

test("in a browser, a card says whether its agent is connected, connects one through Settings, gives the words that have a connected one listen, and Add an agent makes one", async ({
  page,
  quadit: owner,
}) => {
  const tag = randomUUID().slice(0, 6);
  const quiet = { name: `Quiet ${tag}`, handle: `quiet-${tag}` };
  const talker = { name: `Talker ${tag}`, handle: `talker-${tag}` };
  await owner.cli("do", "agent.create", JSON.stringify(quiet));
  await owner.cli("do", "agent.create", JSON.stringify(talker));
  // The talker gives a connect code back from Claude Code, and listens to nothing.
  const made = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/tokens`, {
    data: { user: `@${talker.handle}` },
    headers: fromOwnPage(currentRun().url),
  });
  const { token } = (await made.json()) as { token: string };
  const code = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/connect-codes`, {
    data: { agent: `@${talker.handle}`, tool: "Claude Code" },
    headers: fromOwnPage(currentRun().url),
  });
  expect(code.status()).toBe(201);
  await quadit(currentRun(), token, ["connect", ((await code.json()) as { code: string }).code]);

  await page.goto(`/${WORKSPACE.slug}/agents`);
  const talking = page.getByRole("article", { name: talker.name });
  await expect(talking.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(talking.getByText("Connected", { exact: true })).toBeVisible();
  await expect(talking.getByText("Not listening. Say “listen to Quadit” to it in a chat.")).toBeVisible();
  await expect(talking.getByRole("button", { name: "Run by Quadit…" })).toHaveCount(0);

  // A browser connects an agent where a connect code is made: its page in Settings.
  await expect(page.getByRole("article", { name: quiet.name }).getByText("Not connected")).toBeVisible();
  await page.getByRole("article", { name: quiet.name }).getByRole("link", { name: "Connect" }).click();
  await expect(page).toHaveURL(`/${WORKSPACE.slug}/settings/agents/${quiet.handle}`);
  await expect(page.getByRole("button", { name: "Make a connect code" })).toBeVisible();

  await page.goto(`/${WORKSPACE.slug}/agents`);
  await page.getByRole("article", { name: talker.name }).getByRole("link", { name: talker.name }).click();
  await expect(page).toHaveURL(`/${WORKSPACE.slug}/settings/agents/${talker.handle}`);

  await page.goto(`/${WORKSPACE.slug}/agents`);
  await page.getByRole("button", { name: "Add an agent" }).click();
  await expect(page.getByRole("dialog", { name: "New agent" })).toBeVisible();
});

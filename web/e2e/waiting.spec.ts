// What waits on a person, and its ways out: a task an agent handed back
// with its result (Looks good, then Mark done); a question sent back,
// closed as no longer needed with a note and settled on the Decisions page;
// and a task closed settling the question still open on it.

import { randomUUID } from "node:crypto";
import { expect, test } from "./quadit";
import { currentRun, fromOwnPage, OWNER, WORKSPACE } from "./run";

type Args = Record<string, unknown>;

/** Sends a change as the agent, with its own token; gives what the change made. */
async function asAgent(type: string, args: Args): Promise<string> {
  const run = currentRun();
  const made = await fetch(`${run.url}/api/v1/w/${WORKSPACE.slug}/changes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${run.agentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), type, args }),
  });
  expect(made.ok, await made.clone().text()).toBe(true);
  return ((await made.json()) as { results: { ref?: string }[] }).results[0]?.ref ?? "";
}

const options = [{ label: "Yes" }, { label: "No" }];

test("a task handed back with a note: Looks good stops the wait, then Mark done closes it", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Make the boss harder");
  await asAgent("comment.create", { task: key, body: "Raised its health in the second phase.", kind: "result" });

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const block = page.getByRole("region", { name: "Waiting on you" });
  await expect(block.getByText("@coder: review the result")).toBeVisible();
  await block.getByRole("button", { name: "Looks good" }).click();
  await expect(block).toHaveCount(0);
  await page.getByRole("button", { name: `Mark ${key} done` }).click();
  await expect.poll(async () => (await quadit.task(key)).status).toBe("Done");
});

test("a question sent back, marked no longer needed with a note, is settled on the Decisions page", async ({
  page,
  project,
}) => {
  const key = await project.newTask("Tune the jump");
  const question = `Should the jump have a double jump? ${randomUUID().slice(0, 6)}`;
  const id = await asAgent("decision.open", { task: key, question, ask: `@${OWNER.handle}`, options });
  const sentBack = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/changes`, {
    data: { id: randomUUID(), type: "decision.pick", args: { id, outcome: "none", note: "Neither yet." } },
    headers: fromOwnPage(currentRun().url),
  });
  expect(sentBack.ok()).toBe(true);

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const card = page.getByRole("article", { name: question });
  await expect(card.getByText("Sent back", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "No longer needed" }).click();
  await card.getByRole("textbox", { name: "Why, in a line (optional)" }).fill("We cut the double jump.");
  await card.getByRole("button", { name: "Mark no longer needed" }).click();
  await expect(card.getByText("We cut the double jump.")).toBeVisible();
  await expect(card.getByText(/marked it no longer needed/)).toBeVisible();

  await page.goto(`/${WORKSPACE.slug}/decisions`);
  const settled = page.getByRole("region", { name: /^Settled/ });
  await expect(settled.getByRole("link", { name: new RegExp(question.replace("?", "\\?")) })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Waiting on/ }).getByText(question)).toHaveCount(0);
});

test("closing a task settles the question still open on it", async ({ page, project, quadit }) => {
  const key = await project.newTask("Draw the map");
  const question = `Which island comes first? ${randomUUID().slice(0, 6)}`;
  await asAgent("decision.open", { task: key, question, ask: `@${OWNER.handle}`, options });
  await quadit.cli("update", key, "status=Done");

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const card = page.getByRole("article", { name: question });
  await expect(card.getByText("No longer needed").first()).toBeVisible();
  await expect(card.getByRole("button", { name: /^This one/ })).toHaveCount(0);
});

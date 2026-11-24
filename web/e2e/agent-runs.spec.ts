// Quadit runs the agent for a task (agent-runs contract §7, §11.3): a test
// plays Quadit's runner by holding the agent's listener of a project with
// GET /listen and machine_id=, and records runs with session.start and
// session.update as the agent. The comment box then says what a comment
// will do, and the task's Sessions show the run as it goes, in words, with
// Stop.

import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, invitedMember, test, type Quadit } from "./quadit";
import { currentRun, fromOwnPage, OWNER, quadit, WORKSPACE } from "./run";

/** What the pretend runner says of itself. */
const RUNNER = { machine_id: "0123456789abcdef", machine_name: "E2E Mac", folder: "~/devel/game", program: "claude" };

interface Agent {
  handle: string;
  token: string;
  /** Runs `quadit ARGS…` as the agent. */
  as(...args: string[]): Promise<string>;
}

/** A new agent the owner answers for, with a token of its own. */
async function newAgent(page: Page, owner: Quadit): Promise<Agent> {
  const handle = `runs-${randomUUID().slice(0, 6)}`;
  await owner.cli("do", "agent.create", JSON.stringify({ name: "Runs", handle }));
  const made = await page.request.post(`/api/v1/w/${WORKSPACE.slug}/tokens`, {
    data: { user: `@${handle}` },
    headers: fromOwnPage(currentRun().url),
  });
  expect(made.status()).toBe(201);
  const { token } = (await made.json()) as { token: string };
  return { handle, token, as: (...args) => quadit(currentRun(), token, args) };
}

/** One hold of the agent's listener of `project` as Quadit's runner, without waiting; gives the lease. */
async function hold(agent: Agent, project: string): Promise<string> {
  const query = new URLSearchParams({ project, wait: "0", by: "Quadit's runner", ...RUNNER });
  const answer = await fetch(`${currentRun().url}/api/v1/w/${WORKSPACE.slug}/listen?${query}`, {
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  expect(answer.ok, await answer.clone().text()).toBe(true);
  return ((await answer.json()) as { lease: string }).lease;
}

test("the comment box says a comment starts the agent now on its computer, and that another member's words do not", async ({
  page,
  browser,
  project,
  quadit: owner,
}) => {
  const agent = await newAgent(page, owner);
  const key = await project.newTask("Make the boss harder", `assignee=@${agent.handle}`);
  // Held after the assignment: a runner's first hold starts at the present, so nothing waits in its queue.
  await hold(agent, project.key);

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByText(`Starts @${agent.handle} now on E2E Mac.`)).toBeVisible();

  const { context } = await invitedMember(browser, page.request, `Member ${randomUUID().slice(0, 6)}`);
  const other = await context.newPage();
  await other.goto(`/${WORKSPACE.slug}/task/${key}`);
  await expect(
    other
      .getByRole("region", { name: "Activity" })
      .getByText(
        `Will not start: only ${OWNER.name}'s words, or their agents', start @${agent.handle}. Ask ${OWNER.name}, or assign the task to an agent of your own.`,
      ),
  ).toBeVisible();
  await context.close();
});

test("the comment box says a comment waits for a computer that went offline", async ({
  page,
  project,
  quadit: owner,
}) => {
  // A runner's lease lives 90 seconds past its last hold; the line is read again every 20.
  test.setTimeout(180_000);
  const agent = await newAgent(page, owner);
  const key = await project.newTask("Make the boss harder", `assignee=@${agent.handle}`);
  await hold(agent, project.key);

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByText(`Starts @${agent.handle} now on E2E Mac.`)).toBeVisible();
  await expect(
    activity.getByText(new RegExp(`^Starts @${agent.handle} when E2E Mac is back\\. It has been offline since .+\\.$`)),
  ).toBeVisible({ timeout: 150_000 });
});

test("a run's line shows its state and computer, its steps as they come, and Stop asks it to stop", async ({
  page,
  project,
  quadit: owner,
}) => {
  const agent = await newAgent(page, owner);
  const key = await project.newTask("Make the boss harder", `assignee=@${agent.handle}`);
  const lease = await hold(agent, project.key);
  const id = randomUUID();
  await agent.as(
    "do",
    "session.start",
    JSON.stringify({ id, task: key, title: "Make the boss harder", state: "waiting", lease, ...RUNNER }),
  );

  await page.goto(`/${WORKSPACE.slug}/task/${key}`);
  const run = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: /^(Show|Hide) what Make the boss harder did$/ }) });
  await expect(run.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(run.getByText("E2E Mac")).toBeVisible();
  await expect(run.getByText(/^received /)).toBeVisible();

  // The program took the prompt and works: its steps come one update at a time.
  await agent.as(
    "do",
    "session.update",
    JSON.stringify({ id, state: "running", add_steps: [{ tool: "Read", text: "Read the boss's code" }] }),
  );
  await expect(run.getByText("Working", { exact: true })).toBeVisible();
  await run.getByRole("button", { name: "Show what Make the boss harder did" }).click();
  await expect(run.getByText("Read the boss's code")).toBeVisible();
  await agent.as(
    "do",
    "session.update",
    JSON.stringify({ id, add_steps: [{ tool: "Edit", text: "Raise its health" }] }),
  );
  await expect(run.getByText("Raise its health")).toBeVisible();
  // The agent's own words on the way, and commands that say nothing folded into one line.
  await agent.as(
    "do",
    "session.update",
    JSON.stringify({ id, add_steps: [{ text: "I'll run the tests." }, { tool: "shell" }, { tool: "shell" }] }),
  );
  await expect(run.getByText("I'll run the tests.")).toBeVisible();
  await expect(run.getByText("Ran 2 commands")).toBeVisible();
  await expect(run.getByRole("heading", { name: "What it did" })).toBeVisible();

  await run.getByRole("button", { name: `Stop @${agent.handle}'s run on ${key}` }).click();
  await expect(run.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  const sessions = await page.request.get(`/api/v1/w/${WORKSPACE.slug}/list/sessions?task=${key}`);
  const { sessions: rows } = (await sessions.json()) as { sessions: { id: string; stop_requested_at?: number }[] };
  expect(rows.find((row) => row.id === id)?.stop_requested_at).toBeGreaterThan(0);
});

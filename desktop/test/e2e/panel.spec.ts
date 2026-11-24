// The menu-bar panel: what waits on the person, per workspace a window
// shows, answered from the panel by the workspace's own page; the runs open
// now, with Stop; the agents; New task and Open Quadit.

import { randomUUID } from "node:crypto";
import { expect, test } from "./desktop";
import { AGENT, firstDecision, newTask, OWNER, quadit, type Run } from "./run";

/** What a pretend Quadit runner says of itself. */
const RUNNER = { machine_id: "0123456789abcdef", machine_name: "E2E Mac", folder: "~/devel/game", program: "claude" };

/**
 * Holds the agent's listener of `project` as Quadit's runner, acknowledging
 * what it is handed (as a runner takes what already waits), and gives the
 * lease: a run can then be recorded with it.
 */
async function hold(run: Run, project: string): Promise<string> {
  const query = new URLSearchParams({ project, wait: "0", by: "Quadit's runner", ...RUNNER });
  const headers = { Authorization: `Bearer ${run.agentToken}` };
  let lease = "";
  for (;;) {
    if (lease) query.set("lease", lease);
    const answer = await fetch(`${run.direct}/api/v1/w/e2e/listen?${query}`, { headers });
    expect(answer.ok, await answer.clone().text()).toBe(true);
    const held = (await answer.json()) as { lease: string; seq?: number; item?: unknown };
    lease = held.lease;
    if (!held.item) return lease;
    await fetch(`${run.direct}/api/v1/w/e2e/cursors/listen`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ seq: held.seq, lease }),
    });
  }
}

test.afterEach(async ({ run }) => {
  await quadit(run, ["do", "notification.read", JSON.stringify({ all: true })]);
});

test("the panel lists a decision waiting on the person and answers it", async ({ desktop, run }) => {
  const { key } = await newTask(run, "Pick a database");
  await quadit(
    run,
    ["ask", key, "Which database?", "option=SQLite", "option=Postgres", `ask=@${OWNER.handle}`],
    run.agentToken,
  );
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);

  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  await expect(panel.getByRole("heading", { name: /E2E/ })).toBeVisible();
  const question = panel.getByRole("listitem").filter({ hasText: "Which database?" });
  await expect(question).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Coder @coder/ })).toBeVisible();

  await question.getByRole("button", { name: /Postgres/ }).click();
  await expect
    .poll(() => firstDecision(run, key))
    .toMatchObject({ state: "picked", picked_label: "Postgres", decided_by: `@${OWNER.handle}` });
  // Answered, it leaves the panel once the page publishes again.
  await expect(question).toBeHidden();
});

test("a server whose window shows no workspace is listed with a way to open it", async ({ desktop, run }) => {
  await desktop.addServer(run.server, "Work");
  await desktop.hide(run.server);
  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  // The server's own Open, by its name: the panel also ends with Open Quadit.
  await expect(panel.getByRole("button", { name: "Open Work" })).toBeVisible();
});

test("the panel says first what waits on the person: a task that waits on them, with who waits", async ({
  desktop,
  run,
}) => {
  const { key } = await newTask(run, "Check the new level graphics");
  await quadit(run, [
    "do",
    "task.update",
    JSON.stringify({ id: key, assignee: `@${AGENT.handle}`, waiting_on: `@${OWNER.handle}` }),
  ]);
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  const task = panel.getByRole("listitem").filter({ hasText: `${key} Check the new level graphics` });
  await expect(task.getByText(`@${AGENT.handle} waits on you`)).toBeVisible({ timeout: 20_000 });
  // It is the first thing under the workspace's name.
  await expect(panel.getByRole("heading", { level: 3 }).first()).toHaveText("Waiting on you");
  await expect(panel.getByText("Nothing waits on you.")).toBeHidden();
  // The menu bar's number and the Dock say it too.
  await expect.poll(() => desktop.badge()).toBeGreaterThanOrEqual(1);
  // Done with it: nothing waits.
  await quadit(run, ["do", "task.update", JSON.stringify({ id: key, waiting_on: "" })]);
  await expect(task).toBeHidden({ timeout: 20_000 });
});

test("the panel lists a run open now, and Stop asks it to stop through the workspace's page", async ({
  desktop,
  run,
}) => {
  const { project, key } = await newTask(run, "Make the boss harder");
  await quadit(run, ["do", "task.update", JSON.stringify({ id: key, assignee: `@${AGENT.handle}` })]);
  const lease = await hold(run, project);
  const id = randomUUID();
  await quadit(
    run,
    [
      "do",
      "session.start",
      JSON.stringify({ id, task: key, title: "Make the boss harder", state: "waiting", lease, ...RUNNER }),
    ],
    run.agentToken,
  );
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  await expect(panel.getByRole("heading", { name: "Working now" })).toBeVisible({ timeout: 20_000 });
  const row = panel.getByRole("listitem").filter({ hasText: `@${AGENT.handle} ${key} Make the boss harder` });
  await expect(row.getByText(/^Waiting, for \d+m$/)).toBeVisible();
  await row.getByRole("button", { name: `Stop @${AGENT.handle} on ${key}` }).click();
  // The task's runs, as the server lists them (quadit show gives the task, not its runs).
  await expect
    .poll(async () => {
      const listed = await fetch(`${run.direct}/api/v1/w/e2e/list/sessions?task=${key}`, {
        headers: { Authorization: `Bearer ${run.token}` },
      });
      const { sessions } = (await listed.json()) as { sessions?: { id: string; stop_requested_at?: number }[] };
      return !!sessions?.find((s) => s.id === id)?.stop_requested_at;
    })
    .toBe(true);
});

test("the panel ends with New task and Open Quadit, and sizes itself to what it shows", async ({ desktop, run }) => {
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  await expect(panel.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Quadit" })).toBeVisible();
  // No empty area under the footer: the window is as tall as its page (up to its most).
  const sizes = await panel.evaluate(() => ({
    window: window.innerHeight,
    page: Math.ceil(document.getElementById("panel")?.getBoundingClientRect().height ?? 0) + 2,
  }));
  expect(Math.abs(sizes.window - Math.min(Math.max(sizes.page, 120), 620))).toBeLessThanOrEqual(2);
});

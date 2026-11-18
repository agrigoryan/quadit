// The menu-bar panel: what waits on the person, per workspace a window
// shows, answered from the panel by the workspace's own page.

import { expect, test } from "./desktop";
import { firstDecision, newTask, OWNER, quadit } from "./run";

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
  await desktop.addServer(run.server);
  await desktop.hide(run.server);
  await desktop.chooseMenuItem("panel");
  const panel = await desktop.appPage("panel.html");
  await expect(panel.getByRole("button", { name: /^Open / })).toBeVisible();
});

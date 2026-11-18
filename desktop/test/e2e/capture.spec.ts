// Quick capture: the window its global key opens (here through File →
// Quick Capture, which runs the same thing; a test presses no global key)
// makes a task or a page through the workspace's own page.

import { expect, test } from "./desktop";
import { newTask, quadit } from "./run";

test("quick capture makes a task in the chosen project and remembers where", async ({ desktop, run }) => {
  const { project } = await newTask(run, "Something to start the project");
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);

  await desktop.chooseMenuItem("quick-capture");
  const capture = await desktop.appPage("capture.html");
  await expect(capture.getByLabel("Workspace")).toContainText("E2E");
  await capture.getByLabel("Project").selectOption(project);
  await capture.getByLabel("Title").fill("Captured from anywhere");
  await capture.getByRole("textbox", { name: "Text (optional)" }).fill("With a few words.");
  await capture.getByRole("button", { name: "Create" }).click();
  await expect(capture.getByRole("status")).toContainText("Task created.");
  await expect.poll(async () => await quadit(run, ["--json", "tasks"])).toContain("Captured from anywhere");

  // A task needs a project; a page may have none.
  await capture.getByLabel("Page").check();
  await capture.getByLabel("Project").selectOption({ label: "No project" });
  await capture.getByLabel("Title").fill("Captured notes");
  await capture.getByRole("button", { name: "Create" }).click();
  await expect(capture.getByRole("status")).toContainText("Page created.");
  await expect.poll(async () => await quadit(run, ["--json", "docs"])).toContain("Captured notes");

  // Opened again, it offers the last place.
  await capture.close();
  await desktop.chooseMenuItem("quick-capture");
  const again = await desktop.appPage("capture.html");
  await expect(again.getByLabel("Page")).toBeChecked();
});

test("a draft stays bound to its workspace: while that window shows none, nothing is sent anywhere", async ({
  desktop,
  run,
}) => {
  await newTask(run, "Something to start the project");
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await desktop.chooseMenuItem("quick-capture");
  const capture = await desktop.appPage("capture.html");
  await capture.getByLabel("Title").fill("Half a thought");

  // The workspace's page goes (here: the window leaves the web app): the draft has nowhere to go.
  await page.goto(`${run.server}/licenses`);
  await expect(capture.getByText(/Open a workspace in one of Quadit's windows first/)).toBeVisible();
  await expect(capture.getByRole("button", { name: "Create" })).toBeHidden();

  // Back, the draft is still there, for the same workspace.
  await page.goto(`${run.server}/e2e/my-work`);
  await expect(capture.getByLabel("Title")).toHaveValue("Half a thought");
  await expect(capture.getByLabel("Workspace")).toContainText("E2E");
});

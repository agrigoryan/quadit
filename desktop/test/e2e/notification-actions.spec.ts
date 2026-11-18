// A notification's buttons and reply field (macOS): what the person does
// there goes to the page that sent it, which carries it out through the web
// app's own path, while the window stays out of sight.

import { expect, test } from "./desktop";
import { firstDecision, newTask, OWNER, quadit } from "./run";

test.skip(process.platform !== "darwin", "notification buttons and replies are macOS only");

test.afterEach(async ({ run }) => {
  // The owner's inbox is shared by every test: read, it adds nothing to another test's badge.
  await quadit(run, ["do", "notification.read", JSON.stringify({ all: true })]);
});

test("a decision's notification offers its options, and pressing one answers it on the server", async ({
  desktop,
  run,
}) => {
  const { key } = await newTask(run, "Pick a colour scheme");
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.hide(run.server);
  await quadit(
    run,
    ["ask", key, "Which colour?", "option=Blue", "option=Green", `ask=@${OWNER.handle}`],
    run.agentToken,
  );

  await expect
    .poll(async () => (await desktop.lastNotificationOffers()).actions, { timeout: 15_000 })
    .toContainEqual(expect.stringContaining("Green"));
  const { actions } = await desktop.lastNotificationOffers();
  await desktop.pressNotificationAction(actions.findIndex((label) => label.includes("Green")));

  await expect
    .poll(() => firstDecision(run, key))
    .toMatchObject({ state: "picked", picked_label: "Green", decided_by: `@${OWNER.handle}` });
  // Done in the background: the window was not brought back.
  expect(await desktop.isShown(run.server)).toBe(false);
});

test("a reply typed into a mention's notification is posted as the owner's comment", async ({ desktop, run }) => {
  const { key } = await newTask(run, "Renew the certificate");
  await desktop.addServer(run.server);
  await desktop.signedIn(run.server);
  await desktop.hide(run.server);
  await quadit(run, ["comment", key, `@${OWNER.handle} can you look at this?`], run.agentToken);

  await expect.poll(async () => (await desktop.lastNotificationOffers()).reply, { timeout: 15_000 }).toBe(true);
  await desktop.replyToNotification("On it, thanks");

  await expect.poll(async () => await quadit(run, ["--json", "show", key])).toContain("On it, thanks");
  expect(await desktop.isShown(run.server)).toBe(false);
});

test("an action the page cannot carry out opens the window at the notification's path instead", async ({
  desktop,
  run,
}) => {
  const { key } = await newTask(run, "Choose a vendor");
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await desktop.hide(run.server);
  // A notification whose button the page does not know: the page answers no.
  await page.evaluate(
    (path) =>
      window.quaditDesktop?.notify({
        title: "Coder asks",
        body: "Which vendor?",
        path,
        actions: [{ label: "Unknown", request: "nothing-the-page-knows" }],
      }),
    `/e2e/task/${key}`,
  );
  await expect.poll(async () => (await desktop.lastNotificationOffers()).actions).toEqual(["Unknown"]);
  await desktop.pressNotificationAction(0);
  await expect.poll(() => desktop.isShown(run.server)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/e2e/task/${key}$`));
});

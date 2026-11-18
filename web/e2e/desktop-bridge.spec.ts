// The page's half of the desktop app's panel, quick capture and notification
// buttons: in a window of the app, the page tells the app about its
// workspace and carries out what the person asks there. The app is stood in
// for by a bridge put on the page before it loads, which keeps what the
// page tells it and asks the page as the app would.

import type { Page } from "@playwright/test";
import type { DesktopNotification, DesktopOutcome, DesktopRequest, DesktopSummary } from "../src/types/desktop";
import { OWNER } from "./run";
import { expect, test } from "./quadit";

/** What the stand-in keeps: the summaries and notifications the page sent, and its request handler. */
interface StandIn {
  published: (DesktopSummary | null)[];
  notified: DesktopNotification[];
  handler?: (r: DesktopRequest) => Promise<DesktopOutcome>;
}

declare global {
  interface Window {
    standIn: StandIn;
  }
}

/** Puts the stand-in bridge on every page this test opens. */
async function inTheApp(page: Page) {
  await page.addInitScript(() => {
    const standIn: StandIn = { published: [], notified: [] };
    window.standIn = standIn;
    window.quaditDesktop = {
      version: "0.1.0",
      notify: (n) => void standIn.notified.push(n),
      setBadge: () => {},
      publish: (s) => void standIn.published.push(s),
      onRequest: (handler) => {
        standIn.handler = handler;
        return () => (standIn.handler = undefined);
      },
    };
  });
}

/** The newest summary the page published. */
const summary = (page: Page) => page.evaluate(() => window.standIn.published.at(-1) ?? null);

/** Asks the page as the app does when the person acts in it. */
const ask = (page: Page, request: DesktopRequest) =>
  page.evaluate(async (r) => {
    const handler = window.standIn.handler;
    if (!handler) throw new Error("the page is not answering requests");
    return handler(r);
  }, request);

test("a question answered from the app's panel shows as answered", async ({ page, project, quadit }) => {
  await inTheApp(page);
  const key = await project.newTask("Pick a colour scheme");
  await quadit.agent("ask", key, "Which colour?", "option=Blue", "option=Green", `ask=@${OWNER.handle}`);

  await page.goto("/e2e/my-work");
  await expect
    .poll(async () => (await summary(page))?.waiting.find((w) => w.title === "Which colour?")?.actions)
    .toEqual([
      { label: "Blue", request: expect.stringMatching(/^pick:/) },
      { label: "Green", request: expect.stringMatching(/^pick:/) },
    ]);
  const waiting = (await summary(page))?.waiting.find((w) => w.title === "Which colour?");
  const green = waiting?.actions.find((a) => a.label === "Green")?.request ?? "";
  expect(await ask(page, { kind: "action", request: green })).toEqual({ ok: true });

  await page.goto(waiting?.path ?? "");
  const question = page.getByRole("region", { name: "Decisions" }).getByRole("article", { name: "Which colour?" });
  await expect(question.getByRole("article", { name: "Green" }).getByText("Picked")).toBeVisible();
  await expect(question.getByText("Your answer is needed")).toBeHidden();
  await expect.poll(async () => (await summary(page))?.waiting.some((w) => w.title === "Which colour?")).toBe(false);
});

test("a question asked while the window is open is answered from its notification", async ({
  page,
  project,
  quadit,
}) => {
  await inTheApp(page);
  const key = await project.newTask("Choose a font");
  await page.goto("/e2e/my-work");
  await expect.poll(() => summary(page)).not.toBeNull();
  await quadit.agent("ask", key, "Which font?", "option=Serif", "option=Sans", `ask=@${OWNER.handle}`);
  const notice = () =>
    page.evaluate(() => window.standIn.notified.find((n) => n.actions?.some((a) => a.label === "Serif")) ?? null);
  await expect.poll(async () => (await notice())?.actions?.map((a) => a.label)).toEqual(["Serif", "Sans", "Mark read"]);

  // Answered, so that it waits on nobody in the other tests' My work.
  const serif = (await notice())?.actions?.find((a) => a.label === "Serif")?.request ?? "";
  expect(await ask(page, { kind: "action", request: serif })).toEqual({ ok: true });
  await expect
    .poll(
      async () =>
        (JSON.parse(await quadit.cli("--json", "show", key)) as { decisions: { state: string }[] }).decisions[0],
    )
    .toMatchObject({ state: "picked" });
});

test("quick capture creates a task, and says where it is", async ({ page, project, quadit }) => {
  await inTheApp(page);
  await page.goto("/e2e/my-work");
  await expect.poll(async () => (await summary(page))?.projects.map((p) => p.key)).toContain(project.key);

  const outcome = await ask(page, {
    kind: "capture",
    project: project.key,
    what: "task",
    title: "Captured from the app",
    body: "Written in quick capture",
  });
  expect(outcome).toEqual({ ok: true, path: `/e2e/task/${project.key}-1` });
  expect(await quadit.task(`${project.key}-1`)).toMatchObject({ title: "Captured from the app" });
});

test("a refusal comes back in the server's words", async ({ page }) => {
  await inTheApp(page);
  await page.goto("/e2e/my-work");
  await expect.poll(() => summary(page)).not.toBeNull();
  const outcome = await ask(page, { kind: "revoke-token", token: "no-such-token" });
  expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("not found") });
});

test("the browser offers to open the page in the app, and the app's window does not", async ({ page }) => {
  await page.goto("/e2e/my-work");
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menuitem", { name: "Open in desktop app" })).toBeVisible();

  const app = await page.context().newPage();
  await inTheApp(app);
  await app.goto("/e2e/my-work");
  await app.getByRole("button", { name: "Account" }).click();
  await expect(app.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: "Open in desktop app" })).toHaveCount(0);
  await app.close();
});

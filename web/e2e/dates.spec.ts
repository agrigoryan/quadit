// Days picked in the date picker, where the browser's own date box used to
// be: a task's due date typed in words on its panel and cleared from the
// list's row, an epic's start and target (the target not before the start),
// and a new cycle whose end follows its start; and in time zones far either
// side of UTC, the month the picker names is the month its days are in, and
// today's ring is on the zone's today. What reached the server is read back
// through the CLI and the workspace's starting copy.

import type { Page } from "@playwright/test";
import { expect, type Quadit, test } from "./quadit";
import { currentRun } from "./run";

/** The task's due date as the server has it; undefined for none. */
async function dueOf(quadit: Quadit, key: string): Promise<string | undefined> {
  const { task } = JSON.parse(await quadit.cli("--json", "show", key)) as { task: { due_on?: string } };
  return task.due_on;
}

/** The rows of a kind as the workspace's starting copy has them. */
async function rows<T>(page: Page, kind: "epics" | "cycles"): Promise<T[]> {
  const answer = await page.request.get("/api/v1/w/e2e/bootstrap");
  expect(answer.ok()).toBe(true);
  return ((await answer.json()) as Record<string, T[] | undefined>)[kind] ?? [];
}

/** Today in this computer's time zone, which the browser shares, and a number of days on. */
function daysOn(n: number): string {
  const day = new Date();
  day.setDate(day.getDate() + n);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Types words into the open date picker's box. */
async function typeDay(picker: ReturnType<Page["getByRole"]>, words: string) {
  const box = picker.getByRole("textbox");
  await box.fill(words);
}

test("a due date typed in words on the task's panel, and cleared from the list's row", async ({
  page,
  project,
  quadit,
}) => {
  const key = await project.newTask("Paint the fence");
  await page.goto(`/e2e/p/${project.key}/tasks`);
  await page.getByRole("link", { name: `Open ${key}` }).click();
  const panel = page.getByRole("complementary", { name: key });
  await panel.getByRole("button", { name: "Due date: No due date" }).click();

  const picker = page.getByRole("dialog", { name: "Set due date…" });
  await expect(picker.getByRole("textbox", { name: "Due date" })).toBeFocused();
  await typeDay(picker, "soonish");
  await expect(picker.getByText("Can’t read “soonish” as a date")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await typeDay(picker, "in 3 days");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect.poll(() => dueOf(quadit, key)).toBe(daysOn(3));

  // The row shows it too, and its date opens the picker there.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: /^Due date: / }).click();
  await page.getByRole("dialog", { name: "Set due date…" }).getByRole("button", { name: "Clear" }).click();
  await expect.poll(() => dueOf(quadit, key)).toBeUndefined();
});

test("an epic's start and target, the target refused before the start", async ({ page, project }) => {
  await page.goto(`/e2e/p/${project.key}/epics`);
  await page.getByRole("button", { name: "New epic" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New epic" });
  await dialog.getByLabel("Name").fill("Spring launch");

  await dialog.getByRole("button", { name: "Start: No date" }).click();
  const start = page.getByRole("dialog", { name: "Start" });
  await typeDay(start, "2027-01-04");
  await page.keyboard.press("Enter");
  await expect(start).toBeHidden();

  await dialog.getByRole("button", { name: "Target: No date" }).click();
  const target = page.getByRole("dialog", { name: "Target" });
  await typeDay(target, "2027-01-02");
  await expect(target.getByText(/^Not before Jan 4/)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(target).toBeVisible();
  await typeDay(target, "jan 29 2027");
  await page.keyboard.press("Enter");
  await expect(target).toBeHidden();

  await dialog.getByRole("button", { name: "Create epic" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await rows<{ name: string }>(page, "epics")).find((epic) => epic.name === "Spring launch"))
    .toMatchObject({ start_on: "2027-01-04", target_on: "2027-01-29" });
});

test("a new cycle's end follows the start picked", async ({ page, project, quadit }) => {
  await quadit.cli("do", "project.update", JSON.stringify({ id: project.key, settings: { cycles: true } }));
  await page.goto(`/e2e/p/${project.key}/cycles`);
  await page.getByRole("button", { name: /^Starts: / }).click();
  const start = page.getByRole("dialog", { name: "Starts" });
  await typeDay(start, "2027-02-01");
  await page.keyboard.press("Enter");
  // Two weeks, the length of a cycle where the project names none.
  await expect(page.getByRole("button", { name: /^Ends: Feb 14/ })).toBeVisible();
  await page.getByRole("button", { name: "Create cycle" }).click();
  await expect
    .poll(async () =>
      (await rows<{ project_id: string; starts_on: string; ends_on: string }>(page, "cycles")).find(
        (cycle) => cycle.starts_on === "2027-02-01",
      ),
    )
    .toMatchObject({ ends_on: "2027-02-14" });
});

test("in every time zone the picker's month is the month of its days, and today is ringed on the zone's today", async ({
  browser,
  project,
  quadit,
}) => {
  const key = await project.newTask("Plan the offsite");
  await quadit.cli("do", "task.update", JSON.stringify({ id: key, due_on: daysOn(3) }));
  const months = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  for (const timezoneId of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
    const context = await browser.newContext({
      baseURL: currentRun().url,
      storageState: currentRun().storageState,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId,
    });
    const page = await context.newPage();
    await page.goto(`/e2e/p/${project.key}/tasks`);
    await page.getByRole("link", { name: `Open ${key}` }).click();
    await page
      .getByRole("complementary", { name: key })
      .getByRole("button", { name: /^Due date: / })
      .click();
    const picker = page.getByRole("dialog", { name: "Set due date…" });

    /** The grid's name, and the month of its first day that is not another month's, written the same way. */
    const inStep = async () => {
      const first = await picker.locator('[role="gridcell"]:not([data-outside])').first().getAttribute("data-day");
      const grid = await picker.getByRole("grid").getAttribute("aria-label");
      return (
        grid === months.format(new Date(`${first}T00:00:00Z`)) && (await picker.locator("h3").textContent()) === grid
      );
    };
    const zoneToday = new Intl.DateTimeFormat("en-CA", { timeZone: timezoneId }).format(new Date());
    await expect(picker.locator("[data-today]"), timezoneId).toHaveAttribute("data-day", zoneToday);
    expect(await inStep(), timezoneId).toBe(true);
    for (const step of ["Next month", "Next month", "Previous month", "Previous month", "Previous month"]) {
      await picker.getByRole("button", { name: step }).click();
      expect(await inStep(), `${timezoneId}, ${step}`).toBe(true);
    }
    await context.close();
  }
});

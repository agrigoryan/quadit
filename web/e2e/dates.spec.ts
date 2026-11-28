// Days picked in the date picker, where the browser's own date box used to
// be: a task's due date typed in words on its panel and cleared from the
// list's row, an epic's start and target (the target not before the start),
// and a new cycle whose end follows its start; and in time zones far either
// side of UTC, at moments when the day, the month or the year differs from
// zone to zone, the picker opens on the zone's month, the month it names is
// the month its days are in, and today's ring is on the zone's today. What
// reached the server is read back through the CLI and the workspace's
// starting copy.

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

/**
 * Stops the page's clock at a moment, so what it counts from is known. It is
 * set once the app has loaded: Playwright's stand-in for Date, there before
 * the app's code, is no class a subclass of Date can extend, and the date
 * library's own (TZDate) would count in the zone.
 */
async function stopClockAt(page: Page, moment: Date) {
  await page.clock.setFixedTime(moment);
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
  // Noon on 29 November in this computer's time zone, which the browser shares: three days on is in December.
  await stopClockAt(page, new Date(2026, 10, 29, 12));
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
  await expect.poll(() => dueOf(quadit, key)).toBe("2026-12-02");

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

/**
 * Moments when the day, the month or the year is not the same everywhere:
 * the one a run once failed at, late on 30 November (December already at
 * UTC+14), the last half hour of the year in UTC (the next one from India
 * east) and the next morning (still the old year at UTC-11 and UTC-12).
 */
const moments = ["2026-11-28T01:33:00Z", "2026-11-30T10:30:00Z", "2026-12-31T23:30:00Z", "2027-01-01T10:30:00Z"];
const zones = ["Pacific/Kiritimati", "Asia/Kolkata", "UTC", "America/Los_Angeles", "Pacific/Pago_Pago", "Etc/GMT+12"];

for (const moment of moments) {
  test(`at ${moment}, in every time zone the picker opens on the zone's month, today ringed on the zone's today, and its month is the month of its days`, async ({
    browser,
    project,
  }) => {
    const key = await project.newTask("Plan the offsite");
    const months = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    for (const timezoneId of zones) {
      const context = await browser.newContext({
        baseURL: currentRun().url,
        storageState: currentRun().storageState,
        serviceWorkers: "block",
        locale: "en-US",
        timezoneId,
      });
      const page = await context.newPage();
      await page.goto(`/e2e/p/${project.key}/tasks`);
      await stopClockAt(page, new Date(moment));
      await page.getByRole("link", { name: `Open ${key}` }).click();
      await page
        .getByRole("complementary", { name: key })
        .getByRole("button", { name: "Due date: No due date" })
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
      const zoneToday = new Intl.DateTimeFormat("en-CA", { timeZone: timezoneId }).format(new Date(moment));
      /** The month `n` months from the zone's today's, as the grid is named. */
      const monthOn = (n: number) => {
        const today = new Date(`${zoneToday}T00:00:00Z`);
        return months.format(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + n, 1)));
      };
      await expect(picker.getByRole("grid"), timezoneId).toHaveAccessibleName(monthOn(0));
      await expect(picker.locator("[data-today]"), timezoneId).toHaveAttribute("data-day", zoneToday);
      expect(await inStep(), timezoneId).toBe(true);
      let shown = 0;
      for (const step of ["Next month", "Next month", "Previous month", "Previous month", "Previous month"]) {
        await picker.getByRole("button", { name: step }).click();
        shown += step === "Next month" ? 1 : -1;
        await expect(picker.getByRole("grid"), `${timezoneId}, ${step}`).toHaveAccessibleName(monthOn(shown));
        expect(await inStep(), `${timezoneId}, ${step}`).toBe(true);
      }
      await context.close();
    }
  });
}

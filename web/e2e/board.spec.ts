import type { Locator, Page } from "@playwright/test";
import { expect, type Project, type Quadit, test } from "./quadit";

/** A task's card in a column of the board, by the task's key. */
const cardIn = (page: Page, column: string, key: string) =>
  page.getByRole("region", { name: column, exact: true }).getByRole("link", { name: new RegExp(`${key} `) });

const columnOf = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** Resolves once the page has drawn a frame: a hand moves the mouse about once a frame. */
const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

/**
 * Drags a card with the mouse as a hand does: the card scrolled into view
 * (an earlier drag may have scrolled the board), pressed in its middle, moved
 * a few pixels a frame to the point `to` finds on the board as it then is,
 * held there until a screen reader hears it is over `column`, and let go. The
 * point is where the hand lets go: a card is dropped wherever the pointer is.
 */
async function drag(page: Page, card: Locator, to: () => Promise<Point>, column: string) {
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error("the card is not on the screen");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const { x, y } = await to();
  const steps = Math.ceil(Math.hypot(x - from.x, y - from.y) / 8);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps);
    await nextFrame(page);
  }
  const said = page.getByRole("main").getByRole("status");
  await expect(said).toHaveText(new RegExp(` is over ${column}\\.$`));
  await page.mouse.up();
  await expect(said).toHaveText(new RegExp(` dropped in ${column}\\.$`));
}

interface Point {
  x: number;
  y: number;
}

/** A point inside a column, `down` pixels below its top, in the middle of the part of it in view. */
async function inColumn(page: Page, name: string, down: number): Promise<Point> {
  const box = await columnOf(page, name).boundingBox();
  const view = await page.getByRole("main").boundingBox();
  if (!box || !view) throw new Error(`no column ${name}`);
  const left = Math.max(box.x, view.x);
  const right = Math.min(box.x + box.width, view.x + view.width);
  return { x: (left + right) / 2, y: box.y + down };
}

/** Fails the test on any error the page throws, the update loop of React (#185) among them. */
function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return async () => {
    await expect(page.getByText("This page hit a problem")).toBeHidden();
    expect(errors).toEqual([]);
  };
}

/** A project's tasks' keys in the order of their ranks as the server has them: their order in a column. */
async function inRankOrder(quadit: Quadit, project: Project) {
  const listed = JSON.parse(await quadit.cli("--json", "tasks", `project=${project.key}`, "sort=rank")) as {
    tasks: { key: string }[];
  };
  return listed.tasks.map((task) => task.key);
}

async function openBoard(page: Page, project: Project, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(`/e2e/p/${project.key}/board`);
}

/**
 * Lifts the card with Shift+Space, moves it with the arrow to the column
 * beside, and drops it with Space, reading what a screen reader is told.
 */
async function moveAcross(page: Page, key: string, title: string, from: string, to: string, arrow: string) {
  await cardIn(page, from, key).focus();
  await page.keyboard.press("Shift+Space");
  const said = page.getByRole("main").getByRole("status");
  await expect(said).toHaveText(`Picked up ${key} ${title} in ${from}.`);
  // While lifted the card is drawn in the column it is over. dnd-kit measures
  // the columns after the lift, and an arrow pressed before that is lost (a
  // person presses it again), so the arrow is pressed until the card is across.
  await expect(async () => {
    if ((await cardIn(page, to, key).count()) === 0) await page.keyboard.press(arrow);
    await expect(cardIn(page, to, key)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(said).toHaveText(`${key} ${title} is over ${to}.`);
  await page.keyboard.press("Space");
  await expect(said).toHaveText(`${key} ${title} dropped in ${to}.`);
}

// The keyboard path (Shift+Space lifts, the arrows move, Space drops): it is
// what a person without a mouse uses, and it does not depend on pointer timing.
// The card moved is the middle one of three, so the column it leaves is not empty.
test("a card moves to the next column and back from the keyboard", async ({ page, project, quadit }) => {
  const above = await project.newTask("Buy the paint");
  const key = await project.newTask("Paint the fence");
  const below = await project.newTask("Clean the brushes");
  await page.goto(`/e2e/p/${project.key}/board`);
  for (const k of [above, key, below]) await expect(cardIn(page, "Todo", k)).toBeVisible();

  await moveAcross(page, key, "Paint the fence", "Todo", "In Progress", "ArrowRight");
  await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
  await page.reload();
  await expect(cardIn(page, "In Progress", key)).toBeVisible();
  await expect(cardIn(page, "Todo", key)).toBeHidden();

  await moveAcross(page, key, "Paint the fence", "In Progress", "Todo", "ArrowLeft");
  await expect.poll(async () => (await quadit.task(key)).status).toBe("Todo");
  for (const k of [above, below]) expect((await quadit.task(k)).status).toBe("Todo");
});

// The server moves every task of a deleted status, those in the trash too; the
// dialog asks where before the first try, though the column shows no card.
test("a status whose only task is in the trash is deleted once its tasks have a place", async ({
  page,
  project,
  quadit,
}) => {
  await quadit.cli(
    "do",
    "status.create",
    JSON.stringify({ project: project.key, name: "Polish", category: "started" }),
  );
  const key = await project.newTask("Sand the edges", "status=Polish");
  await quadit.cli("delete", key);
  await page.goto(`/e2e/p/${project.key}/board`);
  await page.getByRole("button", { name: "Status options: Polish" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete the status “Polish”?" });
  await expect(dialog.getByText("That counts one task in the trash, which moves too.")).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Move its tasks to" })).toBeVisible();
  await dialog.getByRole("button", { name: "Move tasks and delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Polish", exact: true })).toBeHidden();
  await quadit.cli("restore", key);
  await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
});

// The mouse path. Each drag is a hand's: small steps a frame apart, so the
// card passes over the columns between, and the drop is where the pointer is.
test.describe("dragging cards with the mouse", () => {
  test("a card goes to the column it is dropped in, beside, across several and back to the first", async ({
    page,
    project,
    quadit,
  }) => {
    const checkPage = failOnPageErrors(page);
    await project.newTask("Buy the paint");
    await project.newTask("Mix the paint");
    const [key = "", other = ""] = await inRankOrder(quadit, project);
    await openBoard(page, project, 1500, 900);
    await expect(cardIn(page, "Todo", key)).toBeVisible();

    await drag(page, cardIn(page, "Todo", key), () => inColumn(page, "In Progress", 80), "In Progress");
    await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
    await drag(page, cardIn(page, "In Progress", key), () => inColumn(page, "Waiting", 80), "Waiting");
    await expect.poll(async () => (await quadit.task(key)).status).toBe("Waiting");
    await drag(page, cardIn(page, "Waiting", key), () => inColumn(page, "Backlog", 80), "Backlog");
    await expect.poll(async () => (await quadit.task(key)).status).toBe("Backlog");
    await drag(page, cardIn(page, "Todo", other), () => inColumn(page, "Waiting", 80), "Waiting");
    await expect.poll(async () => (await quadit.task(other)).status).toBe("Waiting");
    // Let go below the column's one card, it goes after it.
    await drag(page, cardIn(page, "Backlog", key), () => inColumn(page, "Waiting", 300), "Waiting");
    await expect.poll(async () => (await quadit.task(key)).status).toBe("Waiting");
    expect(await inRankOrder(quadit, project)).toEqual([other, key]);
    await checkPage();
  });

  // The page used to loop (React's error #185): halfway between two columns the
  // card's neighbour in each column was nearer than the card itself, so it was
  // moved from one to the other and back with every drawing.
  test("a card from a long Done column lands in Waiting beside it", async ({ page, project, quadit }) => {
    const checkPage = failOnPageErrors(page);
    for (let i = 1; i <= 2; i++) await project.newTask(`Ask about ${i}`, "status=Waiting");
    const done: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const long = i % 3 === 0 ? ", with a title long enough to wrap onto a second line and more" : "";
      done.push(await project.newTask(`Finished ${i}${long}`, "status=Done"));
    }
    await openBoard(page, project, 1500, 900);
    const top = columnOf(page, "Done").getByRole("link").first();
    await expect(top).toBeVisible();
    const key = (await top.getAttribute("aria-label"))?.split(" ")[0] ?? "";
    expect(done).toContain(key);

    await drag(page, cardIn(page, "Done", key), () => inColumn(page, "Waiting", 60), "Waiting");
    await expect.poll(async () => (await quadit.task(key)).status).toBe("Waiting");
    await checkPage();
  });

  test("a card dropped on a column partly off the screen lands in it", async ({ page, project, quadit }) => {
    const checkPage = failOnPageErrors(page);
    const key = await project.newTask("Buy the paint");
    await openBoard(page, project, 1100, 800);
    await expect(cardIn(page, "Todo", key)).toBeVisible();
    const column = await columnOf(page, "In Progress").boundingBox();
    expect(column && column.x + column.width).toBeGreaterThan(1100);

    // Near its left edge: the board scrolls by itself when the pointer nears its right edge.
    await drag(
      page,
      cardIn(page, "Todo", key),
      async () => ({ x: (column?.x ?? 0) + 40, y: (column?.y ?? 0) + 120 }),
      "In Progress",
    );
    await expect.poll(async () => (await quadit.task(key)).status).toBe("In Progress");
    await checkPage();
  });

  test("a card dragged above another in its column keeps its new place", async ({ page, project, quadit }) => {
    const checkPage = failOnPageErrors(page);
    for (const title of ["Buy the paint", "Mix the paint", "Paint the fence"]) await project.newTask(title);
    const [first = "", second = "", last = ""] = await inRankOrder(quadit, project);
    await openBoard(page, project, 1500, 900);
    const top = await cardIn(page, "Todo", first).boundingBox();
    if (!top) throw new Error("the first card is not on the screen");

    await drag(page, cardIn(page, "Todo", last), async () => ({ x: top.x + top.width / 2, y: top.y + 10 }), "Todo");
    await expect.poll(() => inRankOrder(quadit, project)).toEqual([last, first, second]);
    expect((await quadit.task(last)).status).toBe("Todo");
    await checkPage();
  });
});

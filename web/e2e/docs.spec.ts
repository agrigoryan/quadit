import { expect, test } from "./quadit";

test("a project page keeps what was typed, gets a sub-page, and is listed with the project's docs", async ({
  page,
  project,
  quadit,
}) => {
  await page.goto(`/e2e/p/${project.key}/docs`);
  await page.getByRole("main").getByRole("button", { name: "New page" }).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Release plan");
  const text = page.getByRole("textbox", { name: "Page text" });
  await text.click();
  // "# " makes a heading, as in Markdown.
  await page.keyboard.type("# Goals");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship the beta by Friday.");
  await expect(text.getByRole("heading", { name: "Goals" })).toBeVisible();

  // Typing is saved on its own: wait until the server has it, then load the page afresh.
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  await expect.poll(() => quadit.cli("doc", id)).toMatch(/# Goals\s+Ship the beta by Friday\./);
  await page.reload();
  await expect(text.getByRole("heading", { name: "Goals" })).toBeVisible();
  await expect(text.getByText("Ship the beta by Friday.")).toBeVisible();
  const tree = page.getByRole("navigation", { name: "Pages" });
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Release plan");

  await tree.getByRole("button", { name: "New page inside Release plan" }).click();
  // On the new page, the parent is a step of the path above the title.
  const where = page.getByRole("navigation", { name: "Where this page is" });
  await expect(where.getByRole("link", { name: "Release plan" })).toBeVisible();
  await page.getByRole("textbox", { name: "Page title" }).fill("Launch checklist");
  await expect(tree.getByRole("link", { name: "Launch checklist" })).toBeVisible();

  await page.goto(`/e2e/p/${project.key}/docs`);
  await expect(tree.getByRole("link", { name: "Release plan" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "Launch checklist" })).toBeVisible();
});

// A title is saved once typing pauses. A reload within that pause must not
// lose it: what waits is handed over as the page goes, and the next page sends it.
test("a page's title typed just before a reload reaches the server", async ({ page, project, quadit }) => {
  const made = JSON.parse(
    await quadit.cli("--json", "do", "doc.create", JSON.stringify({ title: "Draft", project: project.key })),
  ) as { ref: string };
  const title = async () =>
    (JSON.parse(await quadit.cli("--json", "doc", made.ref)) as { doc: { title: string } }).doc.title;

  await page.goto(`/e2e/docs/${made.ref}`);
  const box = page.getByRole("textbox", { name: "Page title" });
  await expect(box).toHaveValue("Draft");
  await box.fill("Quarterly review");
  await page.reload();

  await expect.poll(title).toBe("Quarterly review");
  await expect(box).toHaveValue("Quarterly review");
});

// A column's resize handle is a window splitter: a Tab stop that says the
// column's width, moved with Left and Right (Shift for bigger steps).
test("a database column is resized from the keyboard and keeps its width", async ({ page, project, quadit }) => {
  const made = JSON.parse(
    await quadit.cli(
      "--json",
      "do",
      "doc.create",
      JSON.stringify({ kind: "database", title: "Vendors", project: project.key }),
    ),
  ) as { ref: string };
  await quadit.cli("do", "property.create", JSON.stringify({ database: made.ref, name: "Owner", type: "text" }));
  await quadit.cli("row", made.ref, "Acme paints");
  await page.goto(`/e2e/docs/${made.ref}`);

  const handle = page.getByRole("separator", { name: "Resize Owner" });
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  const start = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 10));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 60));
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 50));

  // Letting go of the key keeps the width: the view's settings on the server say so, and it is there after a reload.
  const widths = async () =>
    (JSON.parse(await quadit.cli("--json", "doc", made.ref)) as { views: { config?: { widths?: object } }[] }).views[0]
      ?.config?.widths;
  await expect.poll(async () => Object.values((await widths()) ?? {})).toEqual([start + 50]);
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", String(start + 50));
});

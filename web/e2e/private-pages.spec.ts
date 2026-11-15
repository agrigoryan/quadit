// A page made private after it had sub-pages takes them along: another
// member does not see them in the tree, find them by search, or open them
// by their address.

import { expect, invitedMember, test } from "./quadit";

test("a private page's earlier sub-pages are not shown to another member", async ({
  browser,
  page: ownerPage,
  project,
  quadit,
}) => {
  const page = async (args: object) =>
    (JSON.parse(await quadit.cli("--json", "do", "doc.create", JSON.stringify(args))) as { ref: string }).ref;
  const words = `Quokka ${project.key}`;
  await page({ title: `Open ${project.key}`, markdown: `${words}, for everyone.\n` });
  const plans = await page({ title: `Plans ${project.key}`, markdown: `${words}, the plans.\n` });
  const quarter = await page({ parent: plans, title: `Quarter ${project.key}`, markdown: `${words}, the quarter.\n` });
  await page({ parent: quarter, title: `Week ${project.key}`, markdown: `${words}, the week.\n` });
  await quadit.cli("do", "doc.update", JSON.stringify({ id: plans, private: true }));

  const { context } = await invitedMember(browser, ownerPage.request, `Member ${project.key}`);
  const member = await context.newPage();

  await member.goto("/e2e/docs");
  const tree = member.getByRole("navigation", { name: "Pages" });
  await expect(tree.getByRole("link", { name: `Open ${project.key}` })).toBeVisible();
  for (const title of ["Plans", "Quarter", "Week"]) {
    await expect(tree.getByRole("link", { name: `${title} ${project.key}` })).toHaveCount(0);
  }

  await member.keyboard.press("ControlOrMeta+k");
  const palette = member.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Command palette" }).fill(words);
  await expect(palette.getByRole("option", { name: new RegExp(`Open ${project.key}`) })).toBeVisible();
  for (const title of ["Plans", "Quarter", "Week"]) {
    await expect(palette.getByRole("option", { name: new RegExp(`${title} ${project.key}`) })).toHaveCount(0);
  }
  await member.keyboard.press("Escape");

  await member.goto(`/e2e/docs/${quarter}`);
  await expect(member.getByRole("main").getByText("This page is not here")).toBeVisible();
  await expect(member.getByText(`${words}, the quarter.`)).toHaveCount(0);

  await context.close();
});

// The inbox's two tabs and the sidebar's number, for a member of their own:
// a mention needs them and is counted; a comment on a task they follow is
// an update, a quiet dot; looking at that task reads it.

import { randomUUID } from "node:crypto";
import { expect, invitedMember, test } from "./quadit";
import { currentRun, fromOwnPage, WORKSPACE } from "./run";

test("Needs you holds what was meant for the member, Updates what they follow; the sidebar counts the first and dots the second", async ({
  page,
  browser,
  project,
  quadit: owner,
}) => {
  const { context, userID } = await invitedMember(browser, page.request, `Reader ${randomUUID().slice(0, 6)}`);
  const members = (await (await page.request.get(`/api/v1/w/${WORKSPACE.slug}/list/members`)).json()) as {
    members: { user_id: string; handle: string }[];
  };
  const handle = members.members.find((m) => m.user_id === userID)?.handle ?? "";

  // The member makes a task, and so follows it; another is the owner's.
  const made = await context.request.post(`/api/v1/w/${WORKSPACE.slug}/changes`, {
    data: { id: randomUUID(), type: "task.create", args: { project: project.key, title: "Tune the jump" } },
    headers: fromOwnPage(currentRun().url),
  });
  expect(made.ok(), await made.text()).toBe(true);
  const followed = ((await made.json()) as { results: { key: string }[] }).results[0]?.key ?? "";
  const other = await project.newTask("Draw the boss");
  // The agent comments on the one the member follows, and mentions the member on the other.
  await owner.agent("do", "comment.create", JSON.stringify({ task: followed, body: "Lowered gravity a little." }));
  await owner.agent("do", "comment.create", JSON.stringify({ task: other, body: `@${handle} can you look at this?` }));

  const reader = await context.newPage();
  await reader.goto(`/${WORKSPACE.slug}/inbox`);
  const needs = reader.getByRole("tab", { name: /^Needs you/ });
  const updates = reader.getByRole("tab", { name: /^Updates/ });
  const inbox = reader.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Inbox/ });
  await expect(needs).toHaveAttribute("aria-selected", "true");
  await expect(needs).toHaveText("Needs you1");
  await expect(updates).toHaveText("Updates1");
  await expect(reader.getByRole("tabpanel").getByRole("link", { name: /mentioned you/ })).toBeVisible();
  await expect(inbox).toHaveText("Inbox1");

  // The tabs are a tablist: the arrow keys move between them.
  await needs.focus();
  await reader.keyboard.press("ArrowRight");
  await expect(updates).toHaveAttribute("aria-selected", "true");
  await expect(reader.getByRole("tabpanel").getByRole("link", { name: /commented/ })).toBeVisible();

  // With what needs the member read, the sidebar has no number, only a dot for the update.
  await needs.click();
  await reader.getByRole("button", { name: "Mark all read" }).click();
  await expect(inbox).toHaveText("Inbox");
  await expect(inbox.getByRole("img", { name: "1 unread update" })).toBeVisible();
  await expect(reader.getByText("Nothing needs you.")).toHaveCount(0);

  // Looking at the followed task for a moment reads its update.
  await reader.goto(`/${WORKSPACE.slug}/task/${followed}`);
  await expect(reader.getByText("Lowered gravity a little.")).toBeVisible();
  await expect(inbox.getByRole("img", { name: "1 unread update" })).toHaveCount(0, { timeout: 5_000 });
  await context.close();
});

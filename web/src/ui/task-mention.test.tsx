// @vitest-environment jsdom
// A task named in text (ui/task-mention.tsx): it shows the task's status,
// key and title as they are now, and a card about the task when the pointer
// rests on it or the keyboard reaches it. Drawn here from Markdown; a page's
// task chip draws the same (docs/editor/chips.test.tsx).

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearStore, loadBootstrap, mergeRows } from "@/data/store";
import { WithQuery } from "@/test/query";
import type { Member, Task, User, Workspace } from "@/types/core";
import { Markdown } from "@/ui/markdown";

const ann = { user_id: "u1", handle: "ann", name: "Ann Owner", kind: "person", role: "owner" } as Member;
const fence = {
  id: "t1",
  key: "SVA-1",
  project_id: "p1",
  status_id: "s1",
  title: "Paint the fence",
  assignee_id: "u1",
  priority: 2,
} as Task;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: ann,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    statuses: [
      { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
      { id: "s2", project_id: "p1", name: "Done", category: "done", rank: "b" },
    ],
    members: [ann],
    tasks: [
      fence,
      { id: "t2", key: "SVA-2", project_id: "p1", status_id: "s1", title: "Old idea", deleted_at: 5 },
      { id: "t3", key: "SVA-3", project_id: "p1", status_id: "s2", title: "Nobody's", priority: 0 },
    ],
  });
});

afterEach(() => vi.restoreAllMocks());

/** Where a click led. */
function Address() {
  const { pathname } = useLocation();
  return <output aria-label="address">{pathname}</output>;
}

function show(text: string) {
  render(
    <MemoryRouter initialEntries={["/acme/tasks"]}>
      <WithQuery>
        <Routes>
          <Route path="*" element={<Markdown text={text} />} />
        </Routes>
        <Address />
      </WithQuery>
    </MemoryRouter>,
  );
}

const card = () => screen.findByRole("tooltip", {}, { timeout: 2000 });

describe("a task named in Markdown", () => {
  it("shows the task's status, key and title, and opens the task like every link to one", () => {
    show("See SVA-1 first.");
    const mention = screen.getByRole("link", { name: "Todo SVA-1 Paint the fence" });
    expect(within(mention).getByRole("img", { name: "Todo" })).toBeInTheDocument();
    expect(mention).toHaveAttribute("href", "/acme/task/SVA-1");
    fireEvent.click(mention);
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent("/acme/task/SVA-1");
  });

  it("follows the task when its status changes elsewhere", () => {
    show("See SVA-1.");
    act(() => mergeRows("tasks", [{ ...fence, status_id: "s2" }]));
    const mention = screen.getByRole("link", { name: /SVA-1/ });
    expect(within(mention).getByRole("img", { name: "Done" })).toBeInTheDocument();
  });

  it("shows a task in the trash as gone, without its status", () => {
    show("Was SVA-2.");
    const mention = screen.getByRole("link", { name: /SVA-2/ });
    expect(mention).toHaveClass("is-gone");
    expect(within(mention).queryByRole("img")).not.toBeInTheDocument();
  });

  it("leaves the key of a project the reader cannot see as text", () => {
    show("Ask about XYZ-1.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Ask about XYZ-1.")).toBeInTheDocument();
  });
});

describe("the card about a task named in text", () => {
  it("opens when the pointer rests on it: key, assignee, title, status and priority", async () => {
    show("See SVA-1.");
    await userEvent.hover(screen.getByRole("link", { name: /SVA-1/ }));
    const about = await card();
    expect(within(about).getByText("SVA-1")).toBeInTheDocument();
    expect(within(about).getByText("Ann Owner")).toBeInTheDocument();
    expect(within(about).getByText("Paint the fence")).toBeInTheDocument();
    expect(within(about).getByText("Todo")).toBeInTheDocument();
    expect(within(about).getByText("High")).toBeInTheDocument();
  });

  it("says when nobody has the task, and leaves out a priority that is not set", async () => {
    show("See SVA-3.");
    await userEvent.hover(screen.getByRole("link", { name: /SVA-3/ }));
    const about = await card();
    expect(within(about).getByText("No assignee")).toBeInTheDocument();
    expect(within(about).queryByText("No priority")).not.toBeInTheDocument();
  });

  it("closes when the pointer leaves, and when the task is opened", async () => {
    show("See SVA-1.");
    const mention = screen.getByRole("link", { name: /SVA-1/ });
    await userEvent.hover(mention);
    await card();
    await userEvent.unhover(mention);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    await userEvent.hover(mention);
    await card();
    fireEvent.click(mention);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("opens when the keyboard reaches the task, and the task is described by it", async () => {
    show("See SVA-1.");
    await userEvent.tab();
    const mention = screen.getByRole("link", { name: /SVA-1/ });
    expect(mention).toHaveFocus();
    await card();
    expect(mention).toHaveAccessibleDescription(/Ann Owner.*Paint the fence.*Todo/);
  });

  it("waits, after a key is pressed, for the pointer to move: text typed around it is no hover", async () => {
    show("See SVA-1.");
    const mention = screen.getByRole("link", { name: /SVA-1/ });
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.pointerOver(mention);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerOut(mention);
    document.dispatchEvent(Object.assign(new Event("pointermove"), { movementX: 3 }));
    fireEvent.pointerOver(mention);
    await card();
  });

  it("asks the server for a task the copy lacks, and shows it in the trash", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      task: { id: "t9", key: "SVA-9", project_id: "p1", status_id: "s1", title: "Lost boss", deleted_at: 7 },
    });
    show("See SVA-9.");
    const mention = screen.getByRole("link", { name: "SVA-9" });
    await userEvent.hover(mention);
    const about = await card();
    expect(await within(about).findByText("Lost boss")).toBeInTheDocument();
    expect(within(about).getByText("In the trash")).toBeInTheDocument();
    expect(mention).toHaveAccessibleName("SVA-9 Lost boss");
  });

  it("says so when the server has no such task", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "task SVA-9 not found" }));
    show("See SVA-9.");
    await userEvent.hover(screen.getByRole("link", { name: "SVA-9" }));
    const about = await card();
    expect(await within(about).findByText("There is no such task, or it is not yours to see.")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
// The card about a member (tasks/member-card.tsx), and where it opens from:
// a member's mention in Markdown, a mention chip in a page, and the assignee
// of a task the reader may not change. The card is a dialog named after the
// member, says who they are and leads to their tasks in the project in view;
// Escape closes it and gives the focus back.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { MentionChip } from "@/docs/editor/chips";
import { MemberCard } from "@/tasks/member-card";
import { TaskRow } from "@/tasks/task-row";
import { WithQuery } from "@/test/query";
import type { Member, Task, User, Workspace } from "@/types/core";
import { Markdown } from "@/ui/markdown";
import { MemberMention } from "@/ui/member-mention";
import { TooltipProvider } from "@/ui/tooltip";

const ann = { user_id: "u1", handle: "ann", name: "Ann Owner", kind: "person", role: "owner" } as Member;
const bot = {
  user_id: "u2",
  handle: "bot",
  name: "Build Bot",
  kind: "agent",
  role: "member",
  responsible_id: "u1",
} as Member;
const gone = { user_id: "u3", handle: "cy", name: "Cy Gone", kind: "person", role: "member", removed_at: 5 } as Member;

const task = { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Boss", assignee_id: "u2" } as Task;

function load(me: Member) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: me.user_id } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Game", rank: "a" }],
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    members: [ann, bot, gone],
    tasks: [task],
  });
}

beforeEach(() => {
  load(ann);
  // What every agent is doing, as the Agents page reads it: the bot's program is listening.
  vi.spyOn(api, "get").mockResolvedValue({
    agents: [{ user_id: "u2", handle: "bot", state: "idle", listening: true }],
  });
});

afterEach(() => vi.restoreAllMocks());

/** Where a link in the card leads. */
function Address() {
  const { pathname, search } = useLocation();
  return <output aria-label="address">{pathname + search}</output>;
}

function show(children: ReactNode) {
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/docs/page"]}>
      <WithQuery>
        <TooltipProvider>
          <MemberMention value={(member, control) => <MemberCard member={member}>{control}</MemberCard>}>
            <Routes>
              <Route path="*" element={children} />
            </Routes>
            <Address />
          </MemberMention>
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

describe("the card about a member", () => {
  it("opens from a mention in Markdown, says who they are, and leads to their tasks", async () => {
    show(<Markdown text="Ask @ann about it." />);
    fireEvent.click(screen.getByRole("button", { name: "About Ann Owner" }));
    const card = await screen.findByRole("dialog", { name: "Ann Owner" });
    expect(within(card).getByText("@ann · Person")).toBeInTheDocument();
    expect(within(card).getByText("Owner")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("link", { name: /Tasks assigned/ }));
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent("/acme/p/SVA/tasks?assignee=%40ann");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says of an agent who answers for it and whether something is listening for its work", async () => {
    show(<Markdown text="@bot will do it." />);
    fireEvent.click(screen.getByRole("button", { name: "About Build Bot" }));
    const card = await screen.findByRole("dialog", { name: "Build Bot" });
    expect(within(card).getByText("@bot · Agent")).toBeInTheDocument();
    expect(within(card).getByText("Ann Owner")).toBeInTheDocument();
    expect(await within(card).findByText("Listening now")).toBeInTheDocument();
  });

  it("closes with Escape and gives the focus back to what opened it", async () => {
    show(<Markdown text="Ask @ann." />);
    const mention = screen.getByRole("button", { name: "About Ann Owner" });
    mention.focus();
    fireEvent.click(mention);
    const card = await screen.findByRole("dialog", { name: "Ann Owner" });
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mention).toHaveFocus());
  });

  it("opens from a mention chip in a page that cannot be edited, with Enter, even for a removed member", async () => {
    show(<MentionChip handle="cy" editable={false} />);
    const chip = screen.getByRole("button", { name: "About Cy Gone" });
    expect(chip).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(chip, { key: "Enter" });
    const card = await screen.findByRole("dialog", { name: "Cy Gone" });
    expect(within(card).getByText("Removed from the workspace")).toBeInTheDocument();
    // Their tasks cannot be filtered by a member who is gone.
    expect(within(card).queryByRole("link")).not.toBeInTheDocument();
  });

  it("leaves a mention of nobody here as text", () => {
    show(<MentionChip handle="nobody" editable={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("@nobody")).toBeInTheDocument();
  });

  it("opens from the assignee of a task the reader may not change, where the avatar would pick no one", async () => {
    load({ ...ann, scope: { read_only: true } });
    show(<TaskRow task={task} />);
    expect(screen.queryByRole("button", { name: /^Assignee/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "About Build Bot" }));
    expect(await screen.findByRole("dialog", { name: "Build Bot" })).toBeInTheDocument();
  });

  it("leaves the assignee's picker to someone who may change the task", () => {
    load(ann);
    show(<TaskRow task={task} />);
    expect(screen.getByRole("button", { name: "Assignee: Build Bot" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "About Build Bot" })).not.toBeInTheDocument();
  });
});

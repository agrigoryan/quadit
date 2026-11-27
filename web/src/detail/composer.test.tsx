// @vitest-environment jsdom
// The comment box of a task (detail/composer.tsx): the same paperclip, @ and
// send arrow as a page's comment box, beside its own "hand to"; @ starts a
// mention where the cursor is, and the arrow or Cmd/Ctrl+Enter sends.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, Task, User, Workspace } from "@/types/core";
import { editDraft, EMPTY_DRAFT } from "@/detail/comment-actions";
import { Composer } from "@/detail/composer";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const sent = vi.hoisted(() => vi.fn());
vi.mock("@/detail/comment-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/detail/comment-actions")>()),
  createComment: sent,
}));

beforeAll(() => {
  // The mention list keeps its highlight in view; jsdom scrolls nothing.
  Element.prototype.scrollIntoView = vi.fn();
});

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const ana = { user_id: "u2", role: "member", name: "Ana Lee", kind: "person", handle: "ana" } as Member;
const task = { id: "t1", key: "SVA-1", title: "Paint the fence", project_id: "p1", status_id: "s1" } as Task;

beforeEach(() => {
  sent.mockClear();
  // A draft outlives its box, as it does when the panel closes.
  editDraft(task.id, () => EMPTY_DRAFT);
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Samurai vs Aliens", rank: "a" }],
    members: [me, ana],
    tasks: [task],
  });
});

function show() {
  render(
    <WithQuery>
      <TooltipProvider>
        <Composer task={task} />
      </TooltipProvider>
    </WithQuery>,
  );
  return screen.getByRole("textbox", { name: "New comment" });
}

describe("a task's comment box", () => {
  it("has the paperclip, @ and the send arrow beside the hand to", () => {
    show();
    expect(screen.getByRole("button", { name: "Then hand to…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mention a person, task or page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("starts a mention where the cursor is with the @ button", async () => {
    const user = userEvent.setup();
    const box = show();
    await user.type(box, "Ask");
    await user.click(screen.getByRole("button", { name: "Mention a person, task or page" }));
    expect(box).toHaveValue("Ask @");
    expect(box).toHaveFocus();
    await user.click(await screen.findByRole("option", { name: /Ana Lee/ }));
    expect(box).toHaveValue("Ask @ana ");
  });

  it("sends with the arrow, and with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const box = show();
    await user.type(box, "Done");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ task, body: "Done" }));
    expect(box).toHaveValue("");
    await user.type(box, "Again");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ task, body: "Again" }));
  });
});

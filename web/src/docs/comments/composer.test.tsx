// @vitest-environment jsdom
// The comment box of a page (docs/comments/composer.tsx): what is written is
// sent with the files given, once they are uploaded; the @ button starts a
// mention where the cursor is; Escape puts a new thread's box away. What is
// written and given is the draft of the box's target: it stays when the box
// goes away and comes back with it, never in another target's box, and goes
// only when sent or cancelled.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { FileRow, Member, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { Composer } from "@/docs/comments/composer";
import { useCommentDrafts } from "@/docs/comments/drafts";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

/** The uploads asked for, each resolved by the test when it says so. */
const uploads: { file: File; land: (row: FileRow | undefined) => void }[] = [];
vi.mock("@/data/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/files")>()),
  uploadOrToast: (file: File) =>
    new Promise<FileRow | undefined>((land) => {
      uploads.push({ file, land });
    }),
}));

beforeAll(() => {
  // The mention list keeps its highlight in view; jsdom scrolls nothing.
  Element.prototype.scrollIntoView = vi.fn();
});

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
const ana = { user_id: "u2", role: "member", name: "Ana Lee", kind: "person", handle: "ana" } as Member;
const row = (name: string) => ({ id: `f-${name}`, name, content_type: "image/png", url: `/f/${name}` }) as FileRow;

beforeEach(() => {
  uploads.length = 0;
  useCommentDrafts.setState({ drafts: {} });
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me, ana],
    docs: [{ id: "d2", title: "Roadmap", project_id: "p1", kind: "page", updated_at: 1 } as Doc],
  });
});

function box(props: Partial<Parameters<typeof Composer>[0]>, onSubmit: () => void) {
  return (
    <WithQuery>
      <TooltipProvider>
        <Composer draft="reply t1" placeholder="Reply…" submitLabel="Reply" onSubmit={onSubmit} autoFocus {...props} />
      </TooltipProvider>
    </WithQuery>
  );
}

function show(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  const view = render(box(props, onSubmit));
  return { onSubmit, view, box: screen.getByRole("textbox", { name: "Reply…" }) };
}

describe("Composer", () => {
  it("sends what is written with the files given, once they are uploaded, and empties itself", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = show();
    const send = screen.getByRole("button", { name: "Reply" });
    expect(send).toBeDisabled();

    await user.type(box, "See the sketch");
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!chooser) throw new Error("no file chooser");
    await user.upload(chooser, new File(["png"], "sketch.png", { type: "image/png" }));
    expect(screen.getByText("sketch.png")).toBeInTheDocument();
    // A file on its way holds the comment back.
    expect(send).toBeDisabled();

    await act(async () => uploads[0]?.land(row("sketch.png")));
    expect(send).toBeEnabled();
    await user.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ body: "See the sketch", files: [row("sketch.png")] });
    expect(box).toHaveValue("");
    expect(screen.queryByText("sketch.png")).toBeNull();
  });

  it("takes files pasted or dropped, leaves out one that failed, and sends on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = show();
    await user.type(box, "Two pictures");
    fireEvent.paste(box, { clipboardData: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    fireEvent.drop(box, {
      dataTransfer: { types: ["Files"], files: [new File(["b"], "b.png", { type: "image/png" })] },
    });
    expect(uploads.map((u) => u.file.name)).toEqual(["a.png", "b.png"]);
    await act(async () => {
      uploads[0]?.land(row("a.png"));
      uploads[1]?.land(undefined);
    });
    expect(screen.queryByText("b.png")).toBeNull();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledWith({ body: "Two pictures", files: [row("a.png")] });
  });

  it("starts a mention where the cursor is with the @ button", async () => {
    const user = userEvent.setup();
    const { box } = show();
    await user.type(box, "Ask");
    await user.click(screen.getByRole("button", { name: "Mention a person, task or page" }));
    expect(box).toHaveValue("Ask @");
    expect(box).toHaveFocus();
    await user.click(await screen.findByRole("option", { name: /Ana Lee/ }));
    expect(box).toHaveValue("Ask @ana ");
  });

  it("writes a page of the page's own project as a link with its title after [[", async () => {
    const user = userEvent.setup();
    const { box } = show({ projectId: "p1" });
    await user.type(box, "See [[[[Road");
    await user.click(await screen.findByRole("option", { name: /Roadmap/ }));
    expect(box).toHaveValue("See [Roadmap](doc:d2)");
  });

  it("puts a new thread's box away on Escape, its draft kept; its cancel button throws the draft away", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const { view } = show({ draft: "block b1", onClose, onCancel });
    await user.keyboard("Half a thought{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    view.unmount();

    const again = show({ draft: "block b1", onClose, onCancel });
    expect(again.box).toHaveValue("Half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    again.view.unmount();
    expect(show({ draft: "block b1" }).box).toHaveValue("");
  });

  it("keeps a draft, text and files, with its target: gone and back, and never in another target's box", async () => {
    const user = userEvent.setup();
    const first = show({ draft: "block A" });
    await user.type(first.box, "On A");
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!chooser) throw new Error("no file chooser");
    await user.upload(chooser, new File(["a"], "a.txt", { type: "text/plain" }));
    first.view.unmount();

    const other = show({ draft: "block B" });
    expect(other.box).toHaveValue("");
    expect(screen.queryByText("a.txt")).toBeNull();
    // The upload lands while A's box is away: it is A's.
    await act(async () => uploads[0]?.land(row("a.txt")));
    expect(screen.queryByText("a.txt")).toBeNull();
    other.view.unmount();

    const back = show({ draft: "block A" });
    expect(back.box).toHaveValue("On A");
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(back.onSubmit).toHaveBeenCalledWith({ body: "On A", files: [row("a.txt")] });
    expect(useCommentDrafts.getState().drafts["block A"]).toBeUndefined();
  });
});

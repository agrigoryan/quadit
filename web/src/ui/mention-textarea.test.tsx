// @vitest-environment jsdom
// What a text box for Markdown offers while it is written in
// (ui/mention-textarea.tsx): typing @ offers the members, and typing [[
// offers the pages by title, the project's and the recently changed first;
// picking one writes it in the form the server reads.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { MentionTextarea } from "@/ui/mention-textarea";

const page = (doc: Partial<Doc> & Pick<Doc, "id" | "title" | "updated_at">) =>
  ({ kind: "page", rank: "a", ...doc }) as Doc;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Samurai vs Aliens", rank: "a" }],
    members: [{ user_id: "u2", handle: "artist", name: "Art", kind: "person", role: "member" }],
    docs: [
      page({ id: "d1", title: "Release notes", updated_at: 50 }),
      page({ id: "d2", title: "Meta rework review", updated_at: 10, project_id: "p1" }),
      page({ id: "d3", title: "Review [draft]", updated_at: 40 }),
      page({ id: "d4", title: "A row", updated_at: 90, kind: "row" }),
      page({ id: "d5", title: "Old review", updated_at: 99, deleted_at: 5 }),
    ],
  });
});

function Box({ projectId }: { projectId?: string }) {
  const [text, setText] = useState("");
  return (
    <WithQuery>
      <MentionTextarea aria-label="Comment" value={text} onChange={setText} projectId={projectId} />
    </WithQuery>
  );
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("a text box for Markdown", () => {
  it("offers the pages after [[, the project's first and then the latest changed, a database's rows and trashed pages left out", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "See [[[[");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(options()).toEqual(["Meta rework review", "Release notes", "Review [draft]"]);
  });

  it("narrows the pages to what is typed, and writes the one picked with Enter as a link to it", async () => {
    render(<Box />);
    const box = screen.getByRole("textbox", { name: "Comment" });
    await userEvent.type(box, "See [[[[revi");
    expect(options()).toEqual(["Review [draft]", "Meta rework review"]);
    expect(box).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]?.id);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(box).toHaveValue("See [Meta rework review](doc:d2)");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("writes a page picked with the pointer, its title's brackets escaped", async () => {
    render(<Box />);
    const box = screen.getByRole("textbox", { name: "Comment" });
    await userEvent.type(box, "[[[[draft");
    await userEvent.click(screen.getByRole("option", { name: "Review [draft]" }));
    expect(box).toHaveValue("[Review \\[draft\\]](doc:d3)");
  });

  it("closes the pages with Escape, and still offers the members after @", async () => {
    render(<Box />);
    const box = screen.getByRole("textbox", { name: "Comment" });
    await userEvent.type(box, "[[[[re");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.type(box, " @ar");
    expect(screen.getByRole("option", { name: /Art.*@artist/ })).toBeInTheDocument();
  });
});

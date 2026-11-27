// @vitest-environment jsdom
// What a text box for Markdown offers while it is written in
// (ui/mention-textarea.tsx): typing @ offers the members, and typing [[
// offers the pages the writer may see by title, the project's and the
// recently changed first; picking one writes it in the form the server
// reads, with its title only where everyone who reads the text may see it.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap, mergeRows } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { MentionTextarea } from "@/ui/mention-textarea";

const page = (doc: Partial<Doc> & Pick<Doc, "id" | "title" | "updated_at">) =>
  ({ kind: "page", rank: "a", ...doc }) as Doc;

const pages = [
  page({ id: "d1", title: "Release notes", updated_at: 50 }),
  page({ id: "d2", title: "Meta rework review", updated_at: 10, project_id: "p1" }),
  page({ id: "d3", title: "Review [draft]", updated_at: 40 }),
  page({ id: "d4", title: "A row", updated_at: 90, kind: "row" }),
  page({ id: "d5", title: "Old review", updated_at: 99, deleted_at: 5 }),
  page({ id: "d6", title: "Vault review", updated_at: 30, project_id: "p2" }),
  page({ id: "d7", title: "My review notes", updated_at: 20, owner_id: "u1" }),
  page({ id: "d8", title: "Bea's review", updated_at: 60, owner_id: "u2" }),
  page({ id: "d9", title: "Specs | v2\nfinal", updated_at: 5 }),
];

function load(scope?: string[]) {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", scope: scope ? { projects: scope } : undefined } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [
      { id: "p1", key: "SVA", name: "Samurai vs Aliens", rank: "a" },
      { id: "p2", key: "OPS", name: "Operations", rank: "b" },
    ],
    members: [{ user_id: "u2", handle: "artist", name: "Art", kind: "person", role: "member" }],
    docs: pages,
  });
}

beforeEach(() => load());
afterEach(() => vi.restoreAllMocks());

function Box({ projectId }: { projectId?: string }) {
  const [text, setText] = useState("");
  return (
    <WithQuery>
      <MentionTextarea aria-label="Comment" value={text} onChange={setText} projectId={projectId} />
    </WithQuery>
  );
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);
const box = () => screen.getByRole("textbox", { name: "Comment" });

describe("a text box for Markdown", () => {
  it("offers the pages after [[, the project's first and then the latest changed, a database's rows, trashed pages and others' private pages left out", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See [[[[");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(options()).toEqual([
      "Meta rework review",
      "Release notes",
      "Review [draft]",
      "Vault review",
      "My review notes",
      "Specs | v2\nfinal",
    ]);
  });

  it("offers no page of a project the writer may not read", async () => {
    load(["p1"]);
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "[[[[review");
    expect(options()).toEqual(["Meta rework review", "Review [draft]", "My review notes"]);
  });

  it("narrows the pages to what is typed, and writes the one picked with Enter as a link to it", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See [[[[revi");
    expect(options()).toEqual(["Meta rework review", "Review [draft]", "Vault review", "My review notes"]);
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]?.id);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(box()).toHaveValue("See [Meta rework review](doc:d2)");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("writes a page picked with the pointer, its title escaped and on one line", async () => {
    render(<Box />);
    await userEvent.type(box(), "[[[[draft");
    await userEvent.click(screen.getByRole("option", { name: "Review [draft]" }));
    expect(box()).toHaveValue("[Review \\[draft\\]](doc:d3)");
    await userEvent.type(box(), " [[[[specs");
    await userEvent.click(screen.getByRole("option", { name: /Specs/ }));
    expect(box()).toHaveValue("[Review \\[draft\\]](doc:d3) [Specs \\| v2 final](doc:d9)");
  });

  it("writes a page only some readers may see by its id alone: another project's, a private one", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "[[[[vault");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(box(), " [[[[my review");
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("doc:d6 doc:d7");
  });

  it("types the page in as the box's own edit, which its undo takes back", async () => {
    const typed = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: typed, configurable: true });
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "[[[[meta");
    await userEvent.keyboard("{Enter}");
    expect(typed).toHaveBeenCalledWith("insertText", false, "[Meta rework review](doc:d2)");
    expect(box()).toHaveValue("[Meta rework review](doc:d2)");
  });

  it("closes the pages when the caret leaves what was typed, by key as by pointer", async () => {
    render(<Box />);
    await userEvent.type(box(), "See [[[[rele");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Home}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Tab}");
    expect(box()).toHaveValue("See [[rele");
  });

  it("leaves Enter to an input method that is composing", async () => {
    render(<Box />);
    await userEvent.type(box(), "[[[[rele");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(box()).toHaveValue("[[rele");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("picks among what is offered still when the list grew shorter under the highlight", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "[[[[review");
    await userEvent.keyboard("{ArrowUp}");
    act(() => mergeRows("docs", [{ ...pages[6], deleted_at: 7 } as Doc, { ...pages[5], deleted_at: 7 } as Doc]));
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("[Review \\[draft\\]](doc:d3)");
  });

  it("closes the pages with Escape, and still offers the members after @", async () => {
    render(<Box />);
    await userEvent.type(box(), "[[[[re");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.type(box(), " @ar");
    expect(screen.getByRole("option", { name: /Art.*@artist/ })).toBeInTheDocument();
  });
});

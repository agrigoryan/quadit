// @vitest-environment jsdom
// What a text box for Markdown offers while it is written in
// (ui/mention-textarea.tsx, ui/mention-menu.tsx): typing @ offers the
// people, the tasks and the pages, each under its heading, and typing [[
// offers the pages alone. Pages the writer may see come by title, the
// project's and the recently changed first; picking one writes it in the
// form the server reads, with its title only where everyone who reads the
// text may see it.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap, mergeRows } from "@/data/store";
import type { Member, Status, Task, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { MentionTextarea } from "@/ui/mention-textarea";

beforeAll(() => {
  // The list keeps its highlight in view; jsdom scrolls nothing.
  Element.prototype.scrollIntoView = vi.fn();
});

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
  page({ id: "d10", title: "Art board", updated_at: 7, project_id: "p1", parent_id: "d2" }),
];

const statuses = [
  { id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" },
  { id: "s2", project_id: "p1", name: "Done", category: "done", rank: "b" },
  { id: "s3", project_id: "p2", name: "Todo", category: "unstarted", rank: "a" },
] as Status[];

const task = (key: string, title: string, updated_at: number, more: Partial<Task> = {}) =>
  ({
    id: key.toLowerCase(),
    key,
    title,
    updated_at,
    project_id: key.startsWith("OPS") ? "p2" : "p1",
    status_id: key.startsWith("OPS") ? "s3" : "s1",
    rank: "a",
    ...more,
  }) as Task;

const tasks = [
  task("SVA-1", "Art direction", 10),
  task("OPS-2", "Artwork for the stand", 50),
  task("SVA-3", "Old art", 90, { status_id: "s2" }),
  task("SVA-4", "Trashed art", 95, { deleted_at: 3 }),
  task("SVA-5", "Archived art", 96, { archived_at: 3 }),
  task("SVA-12", "Boss fight", 1),
  task("SVA-120", "Boss arena", 80),
];

function load(scope?: string[], more: { tasks?: Task[]; members?: Member[] } = {}) {
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
    members: [
      { user_id: "u2", handle: "artist", name: "Art", kind: "person", role: "member" },
      ...(more.members ?? []),
    ] as Member[],
    statuses,
    tasks: more.tasks ?? tasks,
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
const sections = () => screen.queryAllByRole("group");
const headings = () =>
  screen
    .queryAllByRole("group")
    .map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
const section = (name: string) =>
  within(screen.getByRole("group", { name }))
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("a text box for Markdown", () => {
  it("offers the pages after [[, the project's first and then the latest changed, each with where it is, a database's rows, trashed pages and others' private pages left out", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See [[[[");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(sections()).toEqual([]);
    expect(options()).toEqual([
      "Meta rework reviewSamurai vs Aliens",
      "Art boardSamurai vs Aliens › Meta rework review",
      "Release notesTeam",
      "Review [draft]Team",
      "Vault reviewOperations",
      "My review notesPrivate",
    ]);
  });

  it("offers no page of a project the writer may not read", async () => {
    load(["p1"]);
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "[[[[review");
    expect(options()).toEqual(["Meta rework reviewSamurai vs Aliens", "Review [draft]Team", "My review notesPrivate"]);
  });

  it("narrows the pages to what is typed, and writes the one picked with Enter as a link to it", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See [[[[revi");
    expect(options()).toEqual([
      "Meta rework reviewSamurai vs Aliens",
      "Review [draft]Team",
      "Vault reviewOperations",
      "My review notesPrivate",
    ]);
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0]?.id);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(box()).toHaveValue("See [Meta rework review](doc:d2)");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("writes a page picked with the pointer, its title escaped and on one line", async () => {
    render(<Box />);
    await userEvent.type(box(), "[[[[draft");
    await userEvent.click(screen.getByRole("option", { name: /Review \[draft\]/ }));
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

describe("@ in a text box for Markdown", () => {
  it("offers the people, the tasks and the pages that hold what is typed, each under its heading", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See @art");
    expect(headings()).toEqual(["People", "Tasks", "Pages"]);
    // The avatar's initial comes first.
    expect(section("People")).toEqual(["AArt@artist"]);
    // Open before done, the project's before another's, then the latest changed; none trashed or archived.
    expect(section("Tasks")).toEqual(["SVA-1Art direction", "OPS-2Artwork for the stand", "SVA-3Old art"]);
    expect(section("Pages")).toEqual(["Art boardSamurai vs Aliens › Meta rework review"]);
  });

  it("finds a task by its key, the very key first, and leaves out a section with nothing in it", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "@sva-12");
    expect(headings()).toEqual(["Tasks"]);
    expect(section("Tasks")).toEqual(["SVA-12Boss fight", "SVA-120Boss arena"]);
  });

  it("writes the person picked as their handle, the task as its key and the page as the link to it, keys moving across the sections", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "@art");
    const [person, firstTask] = screen.getAllByRole("option");
    expect(box()).toHaveAttribute("aria-activedescendant", person?.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(box()).toHaveAttribute("aria-activedescendant", firstTask?.id);
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("SVA-1 ");

    await userEvent.type(box(), "@art");
    await userEvent.keyboard("{ArrowUp}{Tab}");
    expect(box()).toHaveValue("SVA-1 [Art board](doc:d10) ");

    await userEvent.type(box(), "@ar");
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("SVA-1 [Art board](doc:d10) @artist ");
  });

  it("writes a page by the same rule as [[: another project's by its id alone", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "@vault");
    await userEvent.click(screen.getByRole("option", { name: /Vault review/ }));
    expect(box()).toHaveValue("doc:d6 ");
  });

  it("shows five of a section and how many more, and picking that shows the rest of that section alone", async () => {
    const quests = Array.from({ length: 8 }, (_, i) => task(`SVA-${30 + i}`, `Quest ${i}`, 100 + i));
    load(undefined, { tasks: quests });
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "@quest");
    expect(section("Tasks")).toEqual([
      "SVA-37Quest 7",
      "SVA-36Quest 6",
      "SVA-35Quest 5",
      "SVA-34Quest 4",
      "SVA-33Quest 3",
      "3 more",
    ]);
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(headings()).toEqual(["Tasks"]);
    expect(section("Tasks")).toHaveLength(8);
    // The highlight is on the first of the rest, where the keys left off.
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /Quest 2/ }).id);
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("SVA-32 ");
  });

  it("with nothing typed after it, offers the people first, then the place's tasks and the latest pages", async () => {
    const agents = Array.from({ length: 6 }, (_, i) => ({
      user_id: `a${i}`,
      handle: `bot${i}`,
      name: `Bot ${i}`,
      kind: "agent",
      role: "member",
    })) as Member[];
    load(undefined, { members: agents });
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "@");
    expect(headings()).toEqual(["People", "Tasks", "Pages"]);
    expect(section("People")).toHaveLength(6);
    expect(section("People")[5]).toBe("2 more");
    expect(section("Tasks").slice(0, 3)).toEqual(["SVA-120Boss arena", "SVA-1Art direction", "SVA-12Boss fight"]);
    expect(section("Pages")[0]).toBe("Meta rework reviewSamurai vs Aliens");
  });

  it("closes with Escape and when the caret leaves the @", async () => {
    render(<Box projectId="p1" />);
    await userEvent.type(box(), "See @art");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Backspace}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Home}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

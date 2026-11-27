// @vitest-environment jsdom
// A page named in text (ui/page-mention.tsx), drawn here from Markdown: in
// every form the server reads, it shows the page's icon and its title as it
// is now, and opens the page in the app; a page the reader does not have
// stays its written words.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap, mergeRows, useStore } from "@/data/store";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { Markdown } from "@/ui/markdown";

const REVIEW = "01a21abf-0000-7000-8000-000000000001";
const NOTES = "01a21abf-0000-7000-8000-000000000002";
const GONE = "01a21abf-0000-7000-8000-000000000003";
const ELSEWHERE = "01a21abf-0000-7000-8000-000000000009";

const page = (doc: Partial<Doc> & Pick<Doc, "id" | "title">) =>
  ({ kind: "page", rank: "a", updated_at: Date.now() - 3 * 3_600_000, ...doc }) as Doc;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Samurai vs Aliens", rank: "a" }],
    docs: [
      page({ id: REVIEW, title: "Meta rework review", icon: "🧭", project_id: "p1" }),
      page({ id: NOTES, title: "Notes" }),
      page({ id: "n2", title: "notes" }),
      page({ id: GONE, title: "Old plan", deleted_at: 9 }),
    ],
  });
});

/** Where a click led. */
function Address() {
  const { pathname } = useLocation();
  return <output aria-label="address">{pathname}</output>;
}

function show(text: string) {
  return render(
    <MemoryRouter initialEntries={["/acme/task/SVA-1"]}>
      <WithQuery>
        <Routes>
          <Route path="*" element={<Markdown text={text} />} />
        </Routes>
        <Address />
      </WithQuery>
    </MemoryRouter>,
  ).container.querySelector(".md");
}

describe("a page named in Markdown", () => {
  it("shows a link to doc:ID as the page's icon and title, and opens the page in the app", () => {
    show(`The review: [Meta rework review](doc:${REVIEW}).`);
    const mention = screen.getByRole("link", { name: "Meta rework review" });
    expect(mention).toHaveTextContent("🧭");
    expect(mention).toHaveAttribute("href", `/acme/docs/${REVIEW}`);
    expect(mention).not.toHaveAttribute("target");
    fireEvent.click(mention);
    expect(screen.getByRole("status", { name: "address" })).toHaveTextContent(`/acme/docs/${REVIEW}`);
  });

  it("shows the title the page has now, after it was renamed", () => {
    show(`See [the old name](doc:${REVIEW}).`);
    act(() => mergeRows("docs", [page({ id: REVIEW, title: "Meta rework, final", project_id: "p1" })]));
    expect(screen.getByRole("link", { name: "Meta rework, final" })).toBeInTheDocument();
    expect(screen.queryByText("the old name")).not.toBeInTheDocument();
  });

  it("reads a bare doc:ID, [[Title]] in any case, and a link to the page's address here", () => {
    const text = show(
      `doc:${REVIEW}, [[meta REWORK review]], <${window.location.origin}/acme/p/SVA/docs/${REVIEW}> and [the page](/acme/docs/${REVIEW})`,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(Array(4).fill(`/acme/docs/${REVIEW}`));
    expect(links.map((l) => l.textContent)).toEqual(Array(4).fill("🧭 Meta rework review"));
    expect(text?.textContent).toBe(
      Array(4)
        .fill("🧭 Meta rework review")
        .join(", ")
        .replace(/, (?=[^,]*$)/, " and "),
    );
  });

  it("leaves [[Title]] as written when no page, or more than one, has that title", () => {
    show("[[Notes]] and [[Nothing like it]]");
    expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", `/acme/docs/${NOTES}`);
    show("[[NOTES]] and [[Nothing like it]]");
    expect(screen.getAllByText(/\[\[Nothing like it\]\]/)).toHaveLength(2);
    expect(screen.getByText(/\[\[NOTES\]\]/)).toBeInTheDocument();
  });

  it("shows the written words, quiet and not a link, for a page in the trash or one the reader does not have", () => {
    const text = show(`[Old plan](doc:${GONE}), doc:${ELSEWHERE} and [[Old plan]]`);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(text?.textContent).toBe(`Old plan, doc:${ELSEWHERE} and [[Old plan]]`);
    expect(text?.querySelectorAll(".page-mention.is-gone")).toHaveLength(3);
  });

  it("shows the written words for a page the reader may no longer see: moved to a project not theirs, made private", () => {
    act(() => {
      useStore.setState((s) => ({ me: s.me && { ...s.me, scope: { projects: ["p1"] } } }));
      mergeRows("docs", [
        page({ id: REVIEW, title: "Meta rework review", project_id: "p2" }),
        page({ id: NOTES, title: "Notes", owner_id: "u2" }),
      ]);
    });
    const text = show(`[the review](doc:${REVIEW}) and doc:${NOTES}`);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(text?.textContent).toBe(`the review and doc:${NOTES}`);
  });

  it("shows a link to a title written with a broken escape as its words", () => {
    const text = show("[the plan](page-titled:%E0%A4%A)");
    expect(text?.textContent).toBe("the plan");
  });

  it("leaves a link to a page's address on another site a link that opens elsewhere", () => {
    show(`[theirs](https://other.example/acme/docs/${REVIEW})`);
    expect(screen.getByRole("link", { name: "theirs" })).toHaveAttribute("target", "_blank");
  });
});

describe("the card about a page named in text", () => {
  it("opens when the pointer rests on it: the title, the project and when the page last changed", async () => {
    show(`See doc:${REVIEW}.`);
    await userEvent.hover(screen.getByRole("link", { name: "Meta rework review" }));
    const about = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(within(about).getByText("Meta rework review")).toBeInTheDocument();
    expect(within(about).getByText("Samurai vs Aliens")).toBeInTheDocument();
    expect(within(about).getByText(/Changed 3h/)).toBeInTheDocument();
  });
});

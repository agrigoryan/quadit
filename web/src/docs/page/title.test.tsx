// @vitest-environment jsdom
// A page's title (docs/page/title.tsx): a text box for someone who may edit
// the page, plain words for someone who may not.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageTitle } from "@/docs/page/title";
import type { Doc } from "@/types/docs";

const doc = { id: "d1", title: "Release notes", kind: "page", created_at: 1 } as Doc;

describe("PageTitle", () => {
  it("is a text box for someone who may edit the page", () => {
    render(<PageTitle doc={doc} />);
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue("Release notes");
  });

  it("is a heading, and no Tab stop, for someone who may only read the page", () => {
    render(<PageTitle doc={doc} readOnly />);
    expect(screen.queryByRole("textbox")).toBeNull();
    const heading = screen.getByRole("heading", { name: "Release notes" });
    expect(heading).not.toHaveAttribute("tabindex");
  });

  it("names a page with no title as untitled for a reader", () => {
    render(<PageTitle doc={{ ...doc, title: "" }} readOnly />);
    expect(screen.getByRole("heading", { name: "Untitled" })).toBeInTheDocument();
  });
});

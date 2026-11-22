// @vitest-environment jsdom
// The files on a question (decisions/question-files.tsx): a text file opens
// in the viewer with the pictures, and anything else stays a link.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import type { OptionFile } from "@/decisions/data";
import { QuestionFiles } from "@/decisions/question-files";
import { TooltipProvider } from "@/ui/tooltip";

afterEach(() => vi.unstubAllGlobals());

function file(name: string, content_type: string): OptionFile {
  return {
    id: name,
    attachmentId: `a-${name}`,
    attachedBy: "u1",
    attachedAt: 0,
    name,
    content_type,
    size: 1,
    state: "ready",
    uploaded_by: "u1",
    created_at: 0,
    url: `/f/${name}`,
  };
}

describe("QuestionFiles", () => {
  it("opens a text file in the viewer after the pictures, and leaves other files as links", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("# Notes")));
    render(
      <MemoryRouter>
        <WithQuery>
          <TooltipProvider>
            <QuestionFiles
              files={[file("a.png", "image/png"), file("notes.md", "text/plain"), file("kit.zip", "application/zip")]}
            />
          </TooltipProvider>
        </WithQuery>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "kit.zip" }).getAttribute("href")).toBe("/f/kit.zip");
    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
    const viewer = screen.getByRole("dialog", { name: "notes.md" });
    expect(await within(viewer).findByRole("heading", { name: "Notes" })).toBeTruthy();
    expect(within(viewer).getByText("2 / 2")).toBeTruthy();
  });
});

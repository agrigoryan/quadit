// @vitest-environment jsdom
// Task keys and mentions in Markdown become links (ui/markdown.tsx), but only
// for a project and a member there are; and a task list's boxes can be ticked
// where the text may be changed.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import { Markdown } from "@/ui/markdown";

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA" }],
    members: [{ user_id: "u2", handle: "artist", name: "Art" }],
  });
  // A key the copy lacks is asked of the server (ui/task-mention.tsx): here there is no such task.
  vi.spyOn(api, "get").mockRejectedValue(new ApiError(404, { message: "not found" }));
});

afterEach(() => vi.restoreAllMocks());

const show = (text: string) =>
  render(
    <MemoryRouter initialEntries={["/acme/tasks"]}>
      <Markdown text={text} />
    </MemoryRouter>,
    { wrapper: WithQuery },
  ).container;

describe("Markdown", () => {
  it("links the key of a project there is, and leaves words like UTF-8 and SHA-256 as text", () => {
    const page = show("Fix SVA-12 for UTF-8 and SHA-256 (see SVA-3).");
    const links = [...page.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["SVA-12", "SVA-3"]);
    expect(links[0]?.getAttribute("href")).toBe("/acme/task/SVA-12");
    expect(page.textContent).toBe("Fix SVA-12 for UTF-8 and SHA-256 (see SVA-3).");
  });

  it("does not take a key out of a longer word or a path", () => {
    const page = show("XSVA-12 and a/SVA-12 stay text");
    expect(page.querySelectorAll("a")).toHaveLength(0);
  });

  it("marks a mention of a member there is, and leaves an unknown handle as text", () => {
    const page = show("ask @artist or @nobody");
    expect([...page.querySelectorAll(".mention")].map((m) => m.textContent)).toEqual(["@artist"]);
    expect(page.textContent).toBe("ask @artist or @nobody");
  });
});

describe("a task list's boxes", () => {
  const text = [
    "Steps:",
    "",
    "- [x] buy paint",
    "  - [ ] the blue",
    "",
    "```",
    "- [ ] not a box, code",
    "```",
    "",
    "1. [ ] paint the wall",
  ].join("\n");

  it("hand the text with the box ticked, or not, to be saved", () => {
    const tick = vi.fn<(next: string) => void>();
    render(
      <MemoryRouter>
        <Markdown text={text} onTick={tick} />
      </MemoryRouter>,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, false]);
    fireEvent.click(boxes[2] as HTMLElement);
    expect(tick).toHaveBeenLastCalledWith(text.replace("1. [ ] paint", "1. [x] paint"));
    fireEvent.click(boxes[0] as HTMLElement);
    expect(tick).toHaveBeenLastCalledWith(text.replace("- [x] buy", "- [ ] buy"));
    fireEvent.click(boxes[1] as HTMLElement);
    expect(tick).toHaveBeenLastCalledWith(text.replace("  - [ ] the blue", "  - [x] the blue"));
  });

  it("are shown, not ticked, where the text may not be changed", () => {
    render(
      <MemoryRouter>
        <Markdown text={text} />
      </MemoryRouter>,
    );
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
  });
});

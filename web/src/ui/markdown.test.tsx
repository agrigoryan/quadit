// @vitest-environment jsdom
// Task keys and mentions in Markdown become links (ui/markdown.tsx), but only
// for a project and a member there are.

import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
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
});

const show = (text: string) =>
  render(
    <MemoryRouter initialEntries={["/acme/tasks"]}>
      <Markdown text={text} />
    </MemoryRouter>,
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

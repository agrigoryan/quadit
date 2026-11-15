// @vitest-environment jsdom
// The chips inside a page's text (docs/editor/chips.tsx) open what they name
// from the keyboard: in a page that cannot be edited they are Tab stops that
// Enter or Space opens; while editing, the caret moves over them.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
import { PageChip, TaskChip } from "@/docs/editor/chips";
import { openDoc, openTask } from "@/docs/nav";

vi.mock("@/docs/nav", () => ({ openDoc: vi.fn(), openTask: vi.fn(), openDecision: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "me", name: "Me" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
    tasks: [{ id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Paint the fence" }],
    docs: [{ id: "d1", title: "Release plan" }],
  });
});

describe("a chip in a page that cannot be edited", () => {
  it("is a Tab stop that Enter opens", () => {
    render(<TaskChip taskKey="SVA-1" editable={false} />);
    const chip = screen.getByRole("link", { name: /SVA-1/ });
    expect(chip).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(openTask).toHaveBeenCalledWith("SVA-1");
  });

  it("opens with Space", () => {
    render(<PageChip docId="d1" editable={false} />);
    fireEvent.keyDown(screen.getByRole("link", { name: /Release plan/ }), { key: " " });
    expect(openDoc).toHaveBeenCalledWith("d1");
  });
});

describe("a chip in a page being edited", () => {
  it("is not a Tab stop and leaves Enter to the editor", () => {
    render(<TaskChip taskKey="SVA-1" editable />);
    const chip = screen.getByRole("link", { name: /SVA-1/ });
    expect(chip).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(openTask).not.toHaveBeenCalled();
  });
});

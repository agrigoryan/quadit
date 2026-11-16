// @vitest-environment jsdom
// A page's row in the docs tree (docs/tree/tree-node.tsx): each of its
// buttons is a Tab stop named after the page; on its name F2 renames it, N
// makes a page inside it and Cmd+Backspace moves it to the trash.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import { clearUndo, nextUndo } from "@/data/undo";
import type { Member, User, Workspace } from "@/types/core";
import type { Doc } from "@/types/docs";
import { useTreeState } from "@/docs/tree/state";
import { TreeNode } from "@/docs/tree/tree-node";
import { TooltipProvider } from "@/ui/tooltip";

const doc = { id: "d1", title: "Release plan", kind: "page", rank: "a" } as Doc;
const next = { id: "d2", title: "Budget", kind: "page", rank: "b" } as Doc;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "me", name: "Me", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    docs: [doc, next],
  });
});

describe("a page's row in the tree", () => {
  it("names its icon button after the page and keeps it in the Tab order", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ul>
            <TreeNode
              doc={doc}
              tree={{ roots: { team: [doc], private: [], memory: [], generated: [] }, children: {} }}
              depth={0}
              editable
              drop={null}
              parentProject={undefined}
            />
          </ul>
        </TooltipProvider>
      </MemoryRouter>,
    );
    const icon = screen.getByRole("button", { name: "Change icon of Release plan" });
    expect(icon).not.toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Actions for Release plan" })).not.toHaveAttribute("tabindex", "-1");
  });
});

/** The two pages at the top of the team's part of the tree. */
function showTree() {
  const tree = { roots: { team: [doc, next], private: [], memory: [], generated: [] }, children: {} };
  render(
    <MemoryRouter initialEntries={["/acme/docs"]}>
      <TooltipProvider>
        <nav>
          <ul>
            {[doc, next].map((page) => (
              <TreeNode key={page.id} doc={page} tree={tree} depth={0} editable drop={null} parentProject={undefined} />
            ))}
          </ul>
        </nav>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const row = (title: string) => screen.getByRole("link", { name: title });
const press = (target: Element, key: string, code: string, more: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(target, { key, code, ...more }));

describe("the keys on a page's name in the tree", () => {
  beforeEach(() => {
    vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
    );
    clearUndo();
    useTreeState.setState({ renaming: null });
  });

  afterEach(async () => {
    await clearOutbox();
    vi.restoreAllMocks();
  });

  it("F2 renames the page", () => {
    showTree();
    press(row("Release plan"), "F2", "F2");
    expect(screen.getByRole("textbox", { name: "Rename" })).toHaveValue("Release plan");
  });

  it("N makes a page inside it, and opens the page in the tree", () => {
    showTree();
    press(row("Release plan"), "n", "KeyN");
    expect(Object.values(getState().collections.docs).filter((d) => d.parent_id === "d1")).toHaveLength(1);
    expect(useTreeState.getState().open.d1).toBe(true);
  });

  it("Cmd+Backspace moves it to the trash, a step to undo, and the next page's name takes the focus", () => {
    showTree();
    row("Release plan").focus();
    press(row("Release plan"), "Backspace", "Backspace", { metaKey: true });
    expect(getState().collections.docs.d1?.deleted_at).toBeTruthy();
    expect(nextUndo()?.name).toBe("delete “Release plan”");
    expect(row("Budget")).toHaveFocus();
  });
});

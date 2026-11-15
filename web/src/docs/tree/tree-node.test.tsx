// @vitest-environment jsdom
// A page's row in the docs tree (docs/tree/tree-node.tsx): each of its
// buttons is a Tab stop named after the page.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
import type { Doc } from "@/lib/types-docs";
import { TreeNode } from "@/docs/tree/tree-node";
import { TooltipProvider } from "@/ui/tooltip";

const doc = { id: "d1", title: "Release plan" } as Doc;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "me", name: "Me", role: "owner" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    docs: [doc],
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

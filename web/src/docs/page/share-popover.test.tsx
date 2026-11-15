// @vitest-environment jsdom
// The share popover (docs/page/share-popover.tsx) names a private page's
// owner, also one who has since left the workspace.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { SharePopover } from "@/docs/page/share-popover";
import { emptyCollections } from "@/lib/collections";
import { useStore } from "@/lib/store";
import type { Member } from "@/types/core";
import type { Doc } from "@/types/docs";
import { TooltipProvider } from "@/ui/tooltip";

const member = (fields: Partial<Member>) =>
  ({ role: "member", kind: "human", handle: "x", name: "", ...fields }) as Member; // only the fields the popover reads

beforeAll(() => {
  const me = member({ user_id: "u2", name: "Bo Reader", handle: "bo" });
  useStore.setState({
    slug: "acme",
    me,
    collections: {
      ...emptyCollections(),
      members: { u2: me, u1: member({ user_id: "u1", name: "Ann Gone", handle: "ann", removed_at: 5 }) },
    },
  });
});

describe("SharePopover", () => {
  it("names the owner of a private page who has left the workspace", () => {
    const page = { id: "d1", title: "Plan", owner_id: "u1", shared_with: ["u2"] } as Doc; // only the fields the popover reads
    render(
      <MemoryRouter>
        <TooltipProvider>
          <SharePopover doc={page} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByText("Private page of Ann Gone, shared with")).toBeInTheDocument();
  });
});

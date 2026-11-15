// @vitest-environment jsdom
// What links to a page (docs/page/backlinks.tsx): only tasks and pages still
// in use are listed; one in the trash or the archive is known, not hidden.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { type BootstrapData, clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/types/core";
import { BacklinksDialog } from "@/docs/page/backlinks";
import { useDocsStore } from "@/docs/store";
import type { DocRef } from "@/types/docs";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;

const fixture: BootstrapData = {
  seq: 1,
  me,
  user: { id: "u1" } as User,
  workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  members: [me],
  statuses: [{ id: "s1", project_id: "p1", name: "Todo", category: "unstarted", rank: "a" }],
  tasks: [
    { id: "t1", key: "SVA-1", project_id: "p1", status_id: "s1", title: "Live task" },
    { id: "t2", key: "SVA-2", project_id: "p1", status_id: "s1", title: "Trashed task", deleted_at: 10 },
    { id: "t3", key: "SVA-3", project_id: "p1", status_id: "s1", title: "Archived task", archived_at: 11 },
  ],
  docs: [
    { id: "target", title: "Target" },
    { id: "doc1", title: "Live page" },
    { id: "doc2", title: "Trashed page", deleted_at: 3 },
  ],
};

const ref = (scope: "task" | "doc", id: string): DocRef => ({
  from_type: scope,
  from_id: id,
  from_scope_type: scope,
  from_scope_id: id,
  to_type: "doc",
  to_id: "target",
});

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", fixture);
  useDocsStore.setState({
    meta: {
      target: {
        mentions: [],
        mentioned_in: [ref("task", "t1"), ref("task", "t2"), ref("task", "t3"), ref("doc", "doc1"), ref("doc", "doc2")],
      },
    },
  });
});

const show = () =>
  render(
    <TooltipProvider>
      <BacklinksDialog docId="target" open onClose={() => {}} />
    </TooltipProvider>,
  );

describe("BacklinksDialog", () => {
  it("lists the live task and page, not those in the trash or the archive", () => {
    show();
    expect(screen.getByText("Live task")).toBeTruthy();
    expect(screen.getByText("Live page")).toBeTruthy();
    expect(screen.queryByText("Trashed task")).toBeNull();
    expect(screen.queryByText("Archived task")).toBeNull();
    expect(screen.queryByText("Trashed page")).toBeNull();
  });

  it("does not count a trashed or archived task as one this person cannot see", () => {
    show();
    expect(screen.queryByText(/not shown to you|Loading finished work/)).toBeNull();
  });
});

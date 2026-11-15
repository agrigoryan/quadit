// @vitest-environment jsdom
// A project's epics (plan/epics-page.tsx): who may make and change them. A
// read-only member has every change refused by the server, so is offered none.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/lib/store";
import type { Member, User, Workspace } from "@/lib/types";
import { EpicsPage } from "@/insights/plan/epics-page";
import { TooltipProvider } from "@/ui/tooltip";

function show(scope?: Member["scope"]) {
  const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me", scope } as Member;
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    epics: [{ id: "e1", project_id: "p1", name: "Launch", state: "active", rank: "a" }],
  });
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/epics"]}>
      <TooltipProvider>
        <Routes>
          <Route path="/:ws/p/:key/epics" element={<EpicsPage />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

it("lets a member make and change epics", () => {
  show();
  expect(screen.getByRole("button", { name: "New epic" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Actions for Launch" })).toBeTruthy();
});

it("offers a read-only member no change", () => {
  show({ read_only: true });
  expect(screen.getByRole("link", { name: "Launch" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New epic" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Actions for Launch" })).toBeNull();
});

it("offers a member limited to other projects no change here", () => {
  show({ projects: ["p2"] });
  expect(screen.queryByRole("button", { name: "New epic" })).toBeNull();
});

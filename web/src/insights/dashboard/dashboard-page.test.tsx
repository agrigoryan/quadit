// @vitest-environment jsdom
// The dashboard (dashboard/dashboard-page.tsx): the server tells the health
// of the machinery only to an admin of the whole workspace. For anyone else
// the answer has no health, and the page draws no health panel.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { DashboardPage } from "@/insights/dashboard/dashboard-page";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";
import type { Dashboard } from "@/types/dashboard";
import { TooltipProvider } from "@/ui/tooltip";

const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;

const dashboard: Dashboard = {
  waiting_on_me: [],
  asked_of_me: [],
  epics: [],
  flow: { by_status: [], weekly: [], waiting: [] },
  agents: [],
  recent_decisions: [],
  preferences: [],
};

beforeAll(() => {
  // The weekly chart measures its width; jsdom does not.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
  });
});

afterEach(() => vi.restoreAllMocks());

function renderDashboard(answer: Dashboard) {
  vi.spyOn(api, "get").mockResolvedValue(answer);
  render(
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <DashboardPage />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
}

it("draws no health panel when the answer has no health", async () => {
  renderDashboard(dashboard);
  expect(await screen.findByRole("region", { name: "Recent decisions" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Health" })).toBeNull();
});

it("draws the health panel for someone the server tells the health", async () => {
  renderDashboard({ ...dashboard, health: { webhooks_failing: 2 } });
  expect(await screen.findByRole("region", { name: "Health" })).toBeTruthy();
});

// @vitest-environment jsdom
// One cycle's page (plan/cycle-page.tsx): its burn-up chart is read again
// when the project's settings change, since they decide what a task counts.

import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyEvents, clearStore, loadBootstrap, useStore } from "@/data/store";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";
import { CyclePage } from "@/insights/plan/cycle-page";
import { type FakeServer, fakeServer } from "@/test/fake-server";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const CHART = "/api/v1/w/acme/cycles/c1/chart";
let server: FakeServer;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  clearStore();
  const me = { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member;
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a", settings: { cycles: true, estimates: true } }],
    cycles: [{ id: "c1", project_id: "p1", number: 1, starts_on: "2026-11-01", ends_on: "2026-11-14" }],
  });
  useStore.setState({ stream: "live" });
  server = fakeServer();
  server.get(CHART, { days: [], total: 0, done: 0 });
});

afterEach(() => vi.unstubAllGlobals());

it("reads the chart again when the project's settings change", async () => {
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/cycles/c1"]}>
      <WithQuery>
        <TooltipProvider>
          <Routes>
            <Route path="/:ws/p/:key/cycles/:id" element={<CyclePage />} />
          </Routes>
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>,
  );
  await waitFor(() => expect(server.count(CHART)).toBe(1));
  const changed = {
    seq: 2,
    type: "project.updated",
    entity_type: "project",
    entity_id: "p1",
    scope_type: "project",
    scope_id: "p1",
  } as FeedEvent;
  act(() => applyEvents([changed], true));
  await waitFor(() => expect(server.count(CHART)).toBe(2), { timeout: 4000 });
});

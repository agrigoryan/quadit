// @vitest-environment jsdom
// The dashboard's epics (insights/dashboard/epics-panel.tsx): an epic's
// points are shown where the server sends them, which it does where one of
// its tasks is in a project that estimates; elsewhere each task is a point,
// and its count of tasks says it.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { EpicProgress } from "@/types/dashboard";
import { EpicsPanel } from "@/insights/dashboard/epics-panel";

const epic = (id: string, project: string, points?: { points: number; points_done: number }): EpicProgress => ({
  id,
  name: `Epic ${project}`,
  project,
  state: "active",
  total: 4,
  done: 1,
  started: 1,
  ...points,
});

describe("EpicsPanel", () => {
  it("shows points only where the server sends them", () => {
    clearStore();
    loadBootstrap("acme", {
      seq: 1,
      me: { user_id: "u1", handle: "me" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
    });
    render(
      <MemoryRouter>
        <EpicsPanel epics={[epic("e1", "SVA", { points: 4, points_done: 1 }), epic("e2", "OPS")]} showProject />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toMatch(/, 1\/4 points/);
    expect(rows[1]).not.toMatch(/points/);
  });

  it("shows points of 0 where the server sends them", () => {
    render(
      <MemoryRouter>
        <EpicsPanel epics={[epic("e1", "SVA", { points: 0, points_done: 0 })]} showProject />
      </MemoryRouter>,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(", 0/0 points");
  });
});

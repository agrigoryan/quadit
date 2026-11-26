// @vitest-environment jsdom
// The dashboard's epics (insights/dashboard/epics-panel.tsx): an epic's
// points are shown where its project estimates; elsewhere each task is a
// point, and its count of tasks says it.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { EpicProgress } from "@/types/dashboard";
import { EpicsPanel } from "@/insights/dashboard/epics-panel";

const epic = (id: string, project: string): EpicProgress => ({
  id,
  name: `Epic ${project}`,
  project,
  state: "active",
  total: 4,
  done: 1,
  started: 1,
  points: 4,
  points_done: 1,
});

describe("EpicsPanel", () => {
  it("shows points only for an epic of a project that estimates", () => {
    clearStore();
    loadBootstrap("acme", {
      seq: 1,
      me: { user_id: "u1", handle: "me" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
      projects: [
        { id: "p1", key: "SVA", name: "Live", rank: "a", settings: { estimates: true } },
        { id: "p2", key: "OPS", name: "Ops", rank: "b" },
      ],
    });
    render(
      <MemoryRouter>
        <EpicsPanel epics={[epic("e1", "SVA"), epic("e2", "OPS")]} showProject />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toMatch(/, 1\/4 points/);
    expect(rows[1]).not.toMatch(/points/);
  });
});

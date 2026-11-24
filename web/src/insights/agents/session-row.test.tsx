// @vitest-environment jsdom
// A session's line (insights/agents/session-row.tsx) names its state; a
// waiting session is open like a running one (it says when it started), and
// one that did not start is ended like a finished one.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStore } from "@/data/store";
import { SessionRow } from "@/insights/agents/session-row";
import type { AgentSession, SessionState } from "@/types/core";

const now = Date.UTC(2026, 10, 24, 12, 0);

function show(state: SessionState) {
  const session: AgentSession = {
    id: "s1",
    agent_id: "a1",
    title: "Boss fight",
    state,
    started_at: now - 5 * 60_000,
    updated_seq: 1,
  };
  render(
    <ul>
      <SessionRow session={session} now={now} />
    </ul>,
  );
}

beforeEach(() => clearStore());

describe("SessionRow", () => {
  it.each([
    ["waiting", "Waiting", true],
    ["running", "Running", true],
    ["done", "Done", false],
    ["not_started", "Not started", false],
  ] as const)("shows a %s session as %s, open: %s", (state, label, open) => {
    show(state);
    expect(screen.getByTitle(label)).toBeInTheDocument();
    if (open) expect(screen.getByText(/^started /)).toBeInTheDocument();
    else expect(screen.queryByText(/^started /)).toBeNull();
  });
});

// @vitest-environment jsdom
// The admin frame (admin/frame.tsx): an install that requires a second step
// opens the admin area only to a session that took one, so a person who has
// none yet is sent to set it up, as a workspace sends them.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/auth/session";
import type { User } from "@/types/core";
import { AdminFrame } from "@/admin/frame";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";

const SETTINGS = "/api/v1/admin/settings";
let server: FakeServer;

beforeEach(() => {
  server = fakeServer();
  useSession.setState({ user: { id: "u1", name: "Ann", is_admin: true } as User });
});

afterEach(() => vi.unstubAllGlobals());

const openAdmin = () =>
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/account/security" element={<p>setting up the second step</p>} />
        <Route
          path="/admin/*"
          element={
            <AdminFrame>
              <p>the admin area</p>
            </AdminFrame>
          }
        />
      </Routes>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );

describe("AdminFrame", () => {
  it("goes to set up the second step when the install requires one first", async () => {
    server.get(SETTINGS, refuse(403, "this install requires two-step verification", "second_step_required"));
    openAdmin();
    expect(await screen.findByText("setting up the second step")).toBeInTheDocument();
  });

  it("opens once the settings are read", async () => {
    server.get(SETTINGS, { settings: {} });
    openAdmin();
    expect(await screen.findByText("the admin area")).toBeInTheDocument();
  });

  it("says why when the settings cannot be read for another reason", async () => {
    server.get(SETTINGS, refuse(500, "the database is busy"));
    openAdmin();
    expect(await screen.findByText("the database is busy")).toBeInTheDocument();
  });
});

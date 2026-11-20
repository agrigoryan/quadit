// @vitest-environment jsdom
// The set-up page (auth/setup.tsx): the form on a new install, a plain
// sentence instead on one the desktop app runs and sets up itself, nothing
// but a wait until the sign-in options say which, a way to try again when
// they cannot be read, and the sign-in page once the install is set up.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";

const CONFIG = "/api/v1/auth/config";
const byApp = "Set this install up in the Quadit app that runs it.";

const config = (more: Partial<AuthConfig>): AuthConfig => ({
  setup_needed: true,
  password: true,
  passkeys: false,
  registration: false,
  providers: [],
  name: "Quadit",
  ...more,
});

afterEach(() => vi.unstubAllGlobals());

function show(server: FakeServer) {
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<p>the sign-in page</p>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
  return server;
}

describe("SetupPage", () => {
  it("says the app sets up an install it runs, and asks nothing", async () => {
    const server = fakeServer();
    server.get(CONFIG, config({ setup_by_app: true }));
    show(server);
    expect(await screen.findByText(byApp)).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  });

  it("asks for the first account on any other new install", async () => {
    const server = fakeServer();
    server.get(CONFIG, config({ setup_by_app: false }));
    show(server);
    expect(await screen.findByLabelText("Your name")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText(byApp)).toBeNull();
  });

  it("shows no form while the sign-in options are on their way", async () => {
    const server = fakeServer();
    const held = server.hold(CONFIG);
    show(server);
    await vi.waitFor(() => expect(held.calls.length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.queryByText(byApp)).toBeNull();
  });

  it("offers to try again when the sign-in options cannot be read", async () => {
    const server = fakeServer();
    server.get(CONFIG, refuse(503, "the server is starting"));
    show(server);
    const again = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByLabelText("Your name")).toBeNull();
    server.get(CONFIG, config({ setup_by_app: true }));
    await userEvent.click(again);
    expect(await screen.findByText(byApp)).toBeTruthy();
  });

  it("is the sign-in page once the install is set up", async () => {
    const server = fakeServer();
    server.get(CONFIG, config({ setup_needed: false, setup_by_app: true }));
    show(server);
    expect(await screen.findByText("the sign-in page")).toBeTruthy();
  });
});

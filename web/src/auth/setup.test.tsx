// @vitest-environment jsdom
// The set-up page (auth/setup.tsx): the form on a new install, a plain
// sentence instead on one the desktop app runs and sets up itself, and the
// sign-in page once the install is set up.

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
import { fakeServer } from "@/test/fake-server";

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

function show(answer: AuthConfig) {
  fakeServer().get("/api/v1/auth/config", answer);
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<p>the sign-in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SetupPage", () => {
  it("says the app sets up an install it runs, and asks nothing", async () => {
    show(config({ setup_by_app: true }));
    expect(await screen.findByText("Set this install up in the Quadit app that runs it.")).toBeTruthy();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  });

  it("asks for the first account on any other new install", async () => {
    show(config({ setup_by_app: false }));
    expect(await screen.findByLabelText("Your name")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText("Set this install up in the Quadit app that runs it.")).toBeNull();
  });

  it("is the sign-in page once the install is set up", async () => {
    show(config({ setup_needed: false, setup_by_app: true }));
    expect(await screen.findByText("the sign-in page")).toBeTruthy();
  });
});

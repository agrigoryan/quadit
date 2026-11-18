// @vitest-environment jsdom
// The page that signs the desktop app in (auth/desktop-connect.tsx): it asks
// before anything happens, posts Continue to the server with the app's state
// and challenge, and says when the request cannot be right.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopConnectPage } from "@/auth/desktop-connect";
import { type AuthConfig, useSession } from "@/auth/session";
import { api } from "@/data/api";
import type { User } from "@/types/core";

const config: AuthConfig = {
  setup_needed: false,
  password: true,
  passkeys: false,
  registration: false,
  providers: [],
  name: "Studio",
};

const STATE = "c3RhdGUtb2YtdGhlLWFwcC1pdHNlbGYtMzItYnl0ZXM";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

beforeEach(() => {
  useSession.setState({ status: "in", half: false, user: { id: "u1", name: "Ann" } as User });
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/auth/config")) return Promise.resolve(config);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

afterEach(() => void vi.restoreAllMocks());

function show(search: string) {
  render(
    <MemoryRouter initialEntries={[`/desktop/connect${search}`]}>
      <Routes>
        <Route path="/desktop/connect" element={<DesktopConnectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const hidden = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | null)?.value;

describe("the desktop app's sign-in page", () => {
  it("asks who signs in and posts Continue with the app's request", async () => {
    show(`?state=${STATE}&challenge=${CHALLENGE}`);
    expect(
      screen.getByRole("heading", { name: "Sign in to the Quadit app on this computer as Ann?" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/The app will open Studio as you/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue" });
    const form = go.closest("form");
    if (!form) throw new Error("Continue is not in a form");
    expect(form.method).toBe("post");
    expect(new URL(form.action).pathname).toBe("/desktop/connect");
    expect([hidden(form, "state"), hidden(form, "challenge"), hidden(form, "user")]).toEqual([STATE, CHALLENGE, "u1"]);

    fireEvent.submit(form);
    expect(screen.getByText(/Your browser asks to open the Quadit app/)).toBeInTheDocument();
  });

  it("says it was cancelled, and sends nothing", () => {
    show(`?state=${STATE}&challenge=${CHALLENGE}`);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Cancelled" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it.each([
    ["no challenge", `?state=${STATE}`],
    ["no state", `?challenge=${CHALLENGE}`],
    ["a challenge that is not S256's", `?state=${STATE}&challenge=plain`],
    ["a state with other signs", `?state=${STATE}%3Cb%3E&challenge=${CHALLENGE}`],
  ])("refuses %s", (_, search) => {
    show(search);
    expect(screen.getByRole("heading", { name: "This sign-in request is not valid" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

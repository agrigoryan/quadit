// @vitest-environment jsdom
// The sign-in form (auth/login.tsx): one message for a refused sign-in, the
// button off while the request is out, and on to the app once it goes through.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "@/auth/login";
import { type AuthConfig, useSession } from "@/auth/session";
import { api, ApiError } from "@/data/api";

const config: AuthConfig = {
  setup_needed: false,
  password: true,
  passkeys: false,
  registration: false,
  providers: [],
  name: "Quadit",
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** Every sign-in request waits until the test answers it. */
let signIns: Pending[] = [];

beforeEach(() => {
  signIns = [];
  useSession.setState({ status: "out", half: false, user: null });
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/auth/config")) return Promise.resolve(config);
    if (path.includes("/auth/me")) return Promise.resolve({ user: { id: "u1", name: "Ann" }, workspaces: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  vi.spyOn(api, "post").mockImplementation(() => new Promise((resolve, reject) => signIns.push({ resolve, reject })));
});

afterEach(() => void vi.restoreAllMocks());

function show(search = "") {
  render(
    <MemoryRouter initialEntries={[`/login${search}`]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>the app</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const button = () => screen.getByRole("button", { name: /sign(ing)? in/i });

async function fillAndSend() {
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ann@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "not-her-password" } });
  fireEvent.click(button());
}

const refuse = (message: string) =>
  act(async () => signIns[0]?.reject(new ApiError(401, { code: "unauthorized", message })));

describe("LoginPage", () => {
  it("turns the button off while the request is out, and sends one request for a double click", async () => {
    show();
    await fillAndSend();
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent("Signing in…");
    fireEvent.click(button());
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      { email: "ann@example.com", password: "not-her-password" },
      { quiet401: true },
    );
  });

  it("shows the server's one message for a refusal and turns the button back on", async () => {
    show();
    await fillAndSend();
    await refuse("wrong email or password");
    expect(screen.getByRole("alert")).toHaveTextContent("wrong email or password");
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent("Sign in");
  });

  it("keeps a refusal that names a field above the button, not under that field", async () => {
    show();
    await fillAndSend();
    await act(async () => signIns[0]?.reject(new ApiError(400, { message: "email is not valid", field: "email" })));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("email is not valid");
  });

  it("keeps the message while the person types, and clears it when the form is sent again", async () => {
    show();
    await fillAndSend();
    await refuse("wrong email or password");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "her-password" } });
    expect(screen.getByRole("alert")).toHaveTextContent("wrong email or password");
    fireEvent.click(button());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("shows the reason an outside account came back with, until the form is sent", async () => {
    show("?error=that+account+is+not+linked");
    expect(await screen.findByRole("alert")).toHaveTextContent("that account is not linked");
    await fillAndSend();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("moves on to the app once the sign-in goes through", async () => {
    show();
    await fillAndSend();
    await act(async () => signIns[0]?.resolve({}));
    expect(await screen.findByText("the app")).toBeInTheDocument();
  });
});

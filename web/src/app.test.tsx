// @vitest-environment jsdom
// The app's first question, who is signed in (app.tsx), while the server cannot be reached.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { useSession } from "@/auth/session";
import type { User } from "@/types/core";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";

vi.mock("@/auth/create-workspace", () => ({ NoWorkspacePage: () => <p>signed in, with no workspace yet</p> }));
vi.mock("@/auth/login", () => ({ LoginPage: () => <p>the sign-in page</p> }));

const WHO_AM_I = "/api/v1/auth/me";
const user = { id: "u1", name: "Me" } as User;

let server: FakeServer;
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  server = fakeServer();
  server.get(WHO_AM_I, { user, workspaces: [] });
  useSession.setState({ status: "unknown", user: null, workspaces: [], half: false });
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("says the server cannot be reached, keeps asking with longer waits, and opens by itself when it answers", async () => {
    server.down = true;
    render(<App />);
    await settle();
    expect(screen.getByText("Waiting for a connection")).toBeInTheDocument();
    expect(server.count(WHO_AM_I)).toBe(1);
    await later(999);
    expect(server.count(WHO_AM_I)).toBe(1);
    await later(1);
    expect(server.count(WHO_AM_I)).toBe(2);
    await later(2000);
    expect(server.count(WHO_AM_I)).toBe(3);

    server.down = false;
    await later(4000);
    expect(screen.getByText("signed in, with no workspace yet")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for a connection")).toBeNull();
  });

  it("asks again at once when the person says to, or the browser comes back online", async () => {
    server.down = true;
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(server.count(WHO_AM_I)).toBe(2);

    server.down = false;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(screen.getByText("signed in, with no workspace yet")).toBeInTheDocument();
  });

  it("stops asking when it is unmounted", async () => {
    server.down = true;
    const app = render(<App />);
    await settle();
    app.unmount();
    await later(60_000);
    expect(server.count(WHO_AM_I)).toBe(1);
  });

  it("takes any other failure to mean signed out", async () => {
    server.get(WHO_AM_I, refuse(500, "the database is busy"));
    render(<App />);
    await settle();
    expect(useSession.getState().status).toBe("out");
    expect(screen.getByText("the sign-in page")).toBeInTheDocument();
  });
});

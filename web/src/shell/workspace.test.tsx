// @vitest-environment jsdom
// The route of a workspace (shell/workspace.tsx): what is on screen while the
// workspace loads, cannot be reached, is refused, or is taken away while open.
// The server and the live stream are fakes; the shell itself is a stand-in.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/auth/session";
import type { EventStreamHandlers } from "@/data/event-stream";
import { type BootstrapData, clearStore, getState } from "@/data/store";
import { toast } from "@/lib/toast";
import type { Member, User, Workspace } from "@/types/core";
import { WorkspaceRoute } from "@/shell/workspace";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";

const streams = vi.hoisted(() => [] as EventStreamHandlers[]);
vi.mock("@/data/event-stream", () => ({
  openEventStream(_url: string, handlers: EventStreamHandlers) {
    streams.push(handlers);
    return { close() {} };
  },
}));
vi.mock("@/shell/shell", () => ({ Shell: () => <p>the workspace is open</p> }));

const W = "/api/v1/w/acme";
const OPEN_PART = `${W}/bootstrap?part=open`;
const WHOLE = `${W}/bootstrap`;
const WHO_AM_I = "/api/v1/auth/me";

const user = { id: "u1", name: "Me" } as User;
const membership = { id: "w", slug: "acme", name: "Acme", role: "member" as const, handle: "me" };
const copy = (over: Partial<BootstrapData> = {}): BootstrapData => ({
  seq: 10,
  me: { user_id: "u1", role: "member" } as Member,
  user,
  workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  ...over,
});

let server: FakeServer;

/** Lets everything that is due happen, and the screen follow. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function openWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/acme"]}>
      <Routes>
        <Route path="/" element={<p>the list of workspaces</p>} />
        <Route path="/account/security" element={<p>setting up the second step</p>} />
        <Route path="/:ws/*" element={<WorkspaceRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

const tryAgain = () => fireEvent.click(screen.getByRole("button", { name: "Try again" }));

beforeEach(() => {
  vi.useFakeTimers();
  // Every wait before a new try is as long as it can be: data/api.ts shortens them at random.
  vi.spyOn(Math, "random").mockReturnValue(1);
  server = fakeServer();
  server.get(OPEN_PART, copy());
  server.get(WHO_AM_I, { user, workspaces: [membership] });
  server.get(`${W}/me`, {});
  streams.length = 0;
  clearStore();
  useSession.setState({ status: "in", user, workspaces: [membership], half: false });
});

afterEach(() => {
  const unexpected = server.unexpected;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

describe("opening a workspace", () => {
  it("shows the workspace once its copy has arrived", async () => {
    const first = server.hold(OPEN_PART);
    openWorkspace();
    await settle();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("the workspace is open")).toBeNull();

    first.calls[0]?.answer(copy());
    await settle();
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("says so when the server cannot be reached, keeps asking, and opens by itself when it answers", async () => {
    server.down = true;
    openWorkspace();
    await settle();
    expect(screen.getByText("Waiting for a connection")).toBeInTheDocument();
    expect(server.count(OPEN_PART)).toBe(1);
    await later(1500);
    expect(server.count(OPEN_PART)).toBe(2);
    expect(screen.getByText("Waiting for a connection")).toBeInTheDocument();

    server.down = false;
    await later(3000);
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("asks again at once when the person says to, or the browser comes back online", async () => {
    server.down = true;
    openWorkspace();
    await settle();
    tryAgain();
    await settle();
    expect(server.count(OPEN_PART)).toBe(2);
    expect(screen.getByText("Waiting for a connection")).toBeInTheDocument();

    server.down = false;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("keeps a copy from an earlier visit on screen while the server cannot be reached, marked as not current", async () => {
    const earlier = openWorkspace();
    await settle();
    earlier.unmount();

    server.down = true;
    openWorkspace();
    await settle();
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for a connection")).toBeNull();
    expect(getState().stream).toBe("down");

    // A copy already on screen is replaced whole, when the server is back.
    server.down = false;
    server.get(WHOLE, copy({ seq: 20 }));
    await later(4500);
    expect(getState().seq).toBe(20);
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("puts away a copy from an earlier visit when the server now refuses the workspace", async () => {
    const earlier = openWorkspace();
    await settle();
    earlier.unmount();

    // Removed from the workspace meanwhile: a copy already here is asked for whole.
    server.get(WHOLE, refuse(403, "you are not a member of this workspace"));
    openWorkspace();
    await settle();
    expect(screen.queryByText("the workspace is open")).toBeNull();
    expect(screen.getByText("You can't open this workspace")).toBeInTheDocument();
    expect(getState().ready).toBe(false);
    expect(getState().workspace).toBeNull();
  });

  it("says the person may not open it, in the server's words, and does not ask again by itself", async () => {
    server.get(OPEN_PART, refuse(404, "no such workspace"));
    openWorkspace();
    await settle();
    expect(screen.getByText("You can't open this workspace")).toBeInTheDocument();
    expect(screen.getByText("No such workspace.")).toBeInTheDocument();
    await later(60_000);
    expect(server.count(OPEN_PART)).toBe(1);

    server.get(OPEN_PART, copy());
    tryAgain();
    await settle();
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("says what went wrong when the server fails, and asks again only when told to", async () => {
    server.get(OPEN_PART, refuse(500, "the database is busy"));
    openWorkspace();
    await settle();
    expect(screen.getByText("Could not load the workspace")).toBeInTheDocument();
    expect(screen.getByText("the database is busy")).toBeInTheDocument();
    await later(60_000);
    expect(server.count(OPEN_PART)).toBe(1);

    server.get(OPEN_PART, copy());
    tryAgain();
    await settle();
    expect(screen.getByText("the workspace is open")).toBeInTheDocument();
  });

  it("goes to set up the second step when the install requires one first", async () => {
    server.get(OPEN_PART, refuse(403, "this install requires two-step verification", "second_step_required"));
    openWorkspace();
    await settle();
    expect(screen.getByText("setting up the second step")).toBeInTheDocument();
  });

  it("leaves a session that has ended to the sign-in page: nothing is said and nothing asked again", async () => {
    server.get(OPEN_PART, refuse(401, "sign in"));
    openWorkspace();
    await later(60_000);
    expect(useSession.getState().status).toBe("out");
    expect(server.count(OPEN_PART)).toBe(1);
    expect(screen.queryByText("Could not load the workspace")).toBeNull();
    expect(screen.queryByText("You can't open this workspace")).toBeNull();
  });
});

describe("a workspace taken away while it is open", () => {
  it("goes on to the person's other workspaces with a note, when they were removed", async () => {
    const said = vi.spyOn(toast, "info").mockImplementation(() => {});
    openWorkspace();
    await settle();
    server.get(WHO_AM_I, { user, workspaces: [] });
    streams.at(-1)?.onSignal("gone");
    await settle();
    expect(screen.getByText("the list of workspaces")).toBeInTheDocument();
    expect(said).toHaveBeenCalledWith("You no longer have access to Acme.");
    expect(getState().ready).toBe(false);
  });

  it("says they may not open it, in the server's words, when they were suspended", async () => {
    openWorkspace();
    await settle();
    // The server refuses everything of the workspace from now on.
    for (const path of [`${W}/me`, OPEN_PART, WHOLE]) {
      server.get(path, refuse(403, "you are suspended in this workspace"));
    }
    streams.at(-1)?.onSignal("gone");
    await settle();
    expect(screen.getByText("You can't open this workspace")).toBeInTheDocument();
    expect(screen.getByText("You are suspended in this workspace.")).toBeInTheDocument();
    expect(screen.queryByText("the workspace is open")).toBeNull();
  });
});

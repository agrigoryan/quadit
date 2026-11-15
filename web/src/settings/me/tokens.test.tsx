// @vitest-environment jsdom
// Me → API tokens (settings/me/tokens.tsx): the person's own tokens, a read
// that failed with a way to try again, the list asked again after a revoke
// and when the live stream comes back.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap, useStore } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import { MyTokensPage } from "@/settings/me/tokens";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const TOKENS = "/api/v1/w/acme/tokens";
const token = (id: string, name: string, userId = "u1") => ({
  id,
  user_id: userId,
  name,
  prefix: "qd_" + id,
  kind: "token",
  created_by: userId,
  created_at: 1,
});

let server: FakeServer;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Me", kind: "person", handle: "me" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
  });
  useStore.setState({ stream: "live" });
  server = fakeServer();
});

afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <MyTokensPage />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );

describe("MyTokensPage", () => {
  it("lists only the person's own tokens", async () => {
    server.get(TOKENS, { tokens: [token("t1", "laptop"), token("t2", "agent's", "u2")] });
    show();
    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.queryByText("agent's")).toBeNull();
  });

  it("says why the list could not be read and reads it again on Try again", async () => {
    server.get(TOKENS, refuse(500, "database is down"));
    show();
    expect(await screen.findByText("database is down")).toBeTruthy();
    server.get(TOKENS, { tokens: [token("t1", "laptop")] });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("laptop")).toBeTruthy();
  });

  it("shows nothing for a 401: the person is on the way to sign in", async () => {
    server.get(TOKENS, refuse(401, "signed out"));
    show();
    await vi.waitFor(() => expect(server.count(TOKENS)).toBe(1));
    expect(screen.queryByText("signed out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("reads the list again after a token is revoked", async () => {
    server.get(TOKENS, { tokens: [token("t1", "laptop")] });
    server.del(`${TOKENS}/t1`, () => {
      server.get(TOKENS, { tokens: [] });
      return {};
    });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("You have no tokens in this workspace.")).toBeTruthy();
    expect(server.count(`${TOKENS}/t1`)).toBe(1);
  });

  it("reads the list again when the stream comes back", async () => {
    server.get(TOKENS, { tokens: [token("t1", "laptop")] });
    show();
    expect(await screen.findByText("laptop")).toBeTruthy();
    server.get(TOKENS, { tokens: [token("t1", "laptop"), token("t3", "made while away")] });
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    expect(await screen.findByText("made while away")).toBeTruthy();
  });
});

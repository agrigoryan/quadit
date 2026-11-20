// @vitest-environment jsdom
// Me → Profile, the sign-in address (settings/me/profile.tsx): an account
// with no address (an install's owner the desktop app made) is told what
// one is for, and adds one with nothing to confirm when it has no password.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearStore, loadBootstrap } from "@/data/store";
import { ProfilePage } from "@/settings/me/profile";
import { fakeServer } from "@/test/fake-server";
import { WithQuery } from "@/test/query";
import type { Member, User, Workspace } from "@/types/core";

const owner = { id: "u1", kind: "person", name: "Aram Grigoryan" } as User;

beforeEach(() => {
  clearStore();
  loadBootstrap("personal", {
    seq: 1,
    me: { user_id: "u1", role: "owner", name: "Aram Grigoryan", kind: "person", handle: "aram-grigoryan" } as Member,
    user: owner,
    workspace: { id: "w", slug: "personal", name: "Personal" } as Workspace,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProfilePage", () => {
  it("adds a sign-in address to an account with none and no password", async () => {
    fakeServer().get("/api/v1/auth/me", { user: owner, has_password: false, passkeys: 0, workspaces: [] });
    const patch = vi
      .spyOn(api, "patch")
      .mockResolvedValue({ user: { ...owner, email: "aram@example.com" }, has_password: false, passkeys: 0 });
    render(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
      { wrapper: WithQuery },
    );
    expect(await screen.findByText("Set an email and a password to sign in from a browser.")).toBeTruthy();
    expect(screen.getByText("No address")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Change address" }));
    expect(screen.queryByLabelText("Current password")).toBeNull();
    await userEvent.type(screen.getByLabelText("New address"), "aram@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Change address" }));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/auth/me", { email: "aram@example.com" }));
  });
});

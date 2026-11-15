// @vitest-environment jsdom
// A page the workspace copy does not have (docs/page/doc-page.tsx): asked of
// the server, and "not found" only when the server says so. A server that
// could not answer is a failure, with a way to try again.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocPage } from "@/docs/page/doc-page";
import { clearStore, loadBootstrap, useStore } from "@/lib/store";
import type { Member, User, Workspace } from "@/types/core";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";

const PAGE = "/api/v1/w/acme/docs/d9";
let server: FakeServer;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
  useStore.setState({ stream: "live" });
  server = fakeServer();
});

afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <MemoryRouter>
      <DocPage id="d9" />
    </MemoryRouter>,
    { wrapper: WithQuery },
  );

describe("a page not in the copy", () => {
  it("is not found when the server says it is not there", async () => {
    server.get(PAGE, refuse(404, "doc not found"));
    show();
    expect(await screen.findByText("This page is not here")).toBeTruthy();
  });

  it("is a failure, not 'not found', when the server could not answer", async () => {
    server.get(PAGE, refuse(500, "database is down"));
    show();
    expect(await screen.findByText("database is down")).toBeTruthy();
    expect(screen.queryByText("This page is not here")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(server.count(PAGE)).toBe(2));
  });
});

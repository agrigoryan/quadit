// @vitest-environment jsdom
// An audit log (admin/audit-log.tsx): newest first, a page at a time, read
// again from the top when the filters change (once the typing stops), and a
// failed read says why with a way to try again.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "@/admin/audit-log";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const AUDIT = "/api/v1/admin/audit";
const entry = (id: string, action: string) => ({ id, at: 1, action, actor_name: "Ann" });
let server: FakeServer;

beforeEach(() => {
  server = fakeServer();
});

afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <AuditLog title="Audit log" lead="Who did what" back="/admin" endpoint={AUDIT} />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );

describe("AuditLog", () => {
  it("reads a page at a time, the next one from the server's cursor", async () => {
    server.get(`${AUDIT}?limit=100`, { audit: [entry("a1", "signin")], next: "c2" });
    server.get(`${AUDIT}?limit=100&cursor=c2`, { audit: [entry("a2", "token.created")] });
    show();
    expect(await screen.findByText("signin")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("token.created")).toBeTruthy();
    expect(screen.getByText("signin")).toBeTruthy();
    expect(await screen.findByText("That is everything.")).toBeTruthy();
  });

  it("reads again from the top with the filters once the typing stops", async () => {
    server.get(`${AUDIT}?limit=100`, { audit: [entry("a1", "signin")] });
    server.get(`${AUDIT}?action=token*&limit=100`, { audit: [entry("a3", "token.revoked")] });
    show();
    expect(await screen.findByText("signin")).toBeTruthy();
    await userEvent.type(screen.getByRole("combobox", { name: "Action" }), "token*");
    expect(await screen.findByText("token.revoked")).toBeTruthy();
    // One read for the finished word, none for each letter on the way.
    expect(server.requests.filter((r) => r.includes("action=")).length).toBe(1);
  });

  it("says why the log could not be read and reads it again on Try again", async () => {
    server.get(`${AUDIT}?limit=100`, refuse(500, "database is down"));
    show();
    expect(await screen.findByText("database is down")).toBeTruthy();
    server.get(`${AUDIT}?limit=100`, { audit: [entry("a1", "signin")] });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("signin")).toBeTruthy();
  });
});

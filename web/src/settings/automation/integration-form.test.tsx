// @vitest-environment jsdom
// A GitHub integration's form (settings/automation/integration-form.tsx):
// where a task moves offers the status types, and keeps a status named in
// place of one.

import { render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Member, User, Workspace } from "@/types/core";
import type { Integration } from "@/types/automation";
import { IntegrationForm } from "@/settings/automation/integration-form";
import { TooltipProvider } from "@/ui/tooltip";

const integration = (config: Integration["config"]): Integration => ({
  id: "i1",
  kind: "github",
  name: "acme/ops",
  config,
  active: true,
  has_secret: true,
  created_by: "u1",
  created_at: 1,
  updated_seq: 1,
});

const show = (it: Integration) =>
  render(
    <TooltipProvider>
      <IntegrationForm integration={it} onClose={() => {}} onSaved={() => {}} />
    </TooltipProvider>,
  );

const optionsOf = (label: string) =>
  within(screen.getByLabelText(label))
    .getAllByRole("option")
    .map((o) => o.textContent);

beforeAll(() => {
  // The switches measure themselves; jsdom cannot.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("IntegrationForm", () => {
  beforeEach(() => {
    clearStore();
    loadBootstrap("acme", {
      seq: 1,
      me: { user_id: "u1", role: "admin", name: "Me", kind: "person", handle: "me" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    });
  });

  it("offers the five status types", () => {
    show(integration({ repo: "acme/ops", on_merge: "done" }));
    expect(optionsOf("When it merges")).toEqual([
      "Leave the task alone",
      "Backlog",
      "To do",
      "In progress",
      "Done",
      "Canceled",
    ]);
    expect(screen.getByLabelText<HTMLSelectElement>("When it merges").value).toBe("done");
  });

  it("keeps a status named in place of a type", () => {
    show(integration({ repo: "acme/ops", on_open: "Blocked" }));
    expect(screen.getByLabelText<HTMLSelectElement>("When a pull request opens").value).toBe("Blocked");
    expect(optionsOf("When a pull request opens")).toContain("Blocked");
    expect(optionsOf("When it merges")).not.toContain("Blocked");
  });
});

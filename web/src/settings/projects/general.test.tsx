// @vitest-environment jsdom
// How a project estimates, on its General settings
// (settings/projects/general.tsx): the scale with its values, the extended
// scale, zero estimates and how a task without one counts, shown while
// estimates are on, each saved as it is changed.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Member, Project, ProjectSettings, User, Workspace } from "@/types/core";
import { ProjectGeneral } from "@/settings/projects/general";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

type Sent = { type: string; args: Record<string, unknown> };
let sent: Sent[] = [];

beforeAll(() => {
  // The switches measure themselves; jsdom cannot.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  sent = [];
  vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) => {
    const changes = (body as { changes: Sent[] }).changes;
    sent.push(...changes.map(({ type, args }) => ({ type, args })));
    return Promise.resolve({ results: changes.map(() => ({})) });
  });
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
});

function show(settings?: ProjectSettings) {
  clearStore();
  const project = { id: "p1", key: "SVA", name: "Live", rank: "a", settings } as Project;
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "admin", name: "Me", kind: "person", handle: "me" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    projects: [project],
  });
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ProjectGeneral project={project} admin />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

/** The settings the last change sent. */
const lastSettings = () => sent.at(-1)?.args.settings;

describe("the project's estimates", () => {
  it("shows nothing more while estimates are off, and names Fibonacci when they are turned on", async () => {
    show();
    expect(screen.queryByLabelText("Scale")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /^Estimates/ }));
    await waitFor(() => expect(lastSettings()).toEqual({ estimates: true, estimate_scale: "fibonacci" }));
    expect(getState().collections.projects.p1?.settings?.estimate_scale).toBe("fibonacci");
  });

  it("offers each scale with its values, any number read where none is named", () => {
    show({ estimates: true });
    const scale = screen.getByLabelText<HTMLSelectElement>("Scale");
    expect(scale.value).toBe("points");
    expect([...scale.options].map((o) => o.text)).toEqual([
      "Fibonacci: 1, 2, 3, 5, 8",
      "Exponential: 1, 2, 4, 8, 16",
      "Linear: 1, 2, 3, 4, 5",
      "T-shirt: XS, S, M, L, XL",
      "Any number",
    ]);
    expect(screen.queryByRole("switch", { name: /^Extended scale/ })).toBeNull();
  });

  it("saves the scale picked, and the extended scale with the values it adds", async () => {
    show({ estimates: true, estimate_scale: "fibonacci" });
    fireEvent.change(screen.getByLabelText("Scale"), { target: { value: "tshirt" } });
    await waitFor(() => expect(lastSettings()).toEqual({ estimates: true, estimate_scale: "tshirt" }));
    cleanup();
    show({ estimates: true, estimate_scale: "tshirt" });
    const extended = screen.getByRole("switch", { name: /^Extended scale/ });
    expect(extended).toHaveAccessibleName(/Adds XXL and XXXL\.$/);
    fireEvent.click(extended);
    await waitFor(() =>
      expect(lastSettings()).toEqual({ estimates: true, estimate_scale: "tshirt", estimate_extended: true }),
    );
  });

  it("saves zero estimates, and counts a task without an estimate as 1 point until that is turned off", async () => {
    show({ estimates: true, estimate_scale: "linear" });
    fireEvent.click(screen.getByRole("switch", { name: /^Zero estimates/ }));
    await waitFor(() => expect(lastSettings()).toMatchObject({ estimate_zero: true }));
    const counts = screen.getByRole("switch", { name: /^Count a task without an estimate as 1 point/ });
    expect(counts).toBeChecked();
    fireEvent.click(counts);
    await waitFor(() => expect(lastSettings()).toMatchObject({ estimate_ignore_unestimated: true }));
  });
});

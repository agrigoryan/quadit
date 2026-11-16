// @vitest-environment jsdom
// Cmd+B switches a task page between the list and the board (tasks/layout-tabs.tsx):
// a project's page by its address, a saved view in its own state; never from a
// field, where Cmd+B is the field's.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/data/store";
import type { Project } from "@/types/core";
import { LayoutTabs } from "@/tasks/layout-tabs";

const project = { id: "p1", key: "SVA", name: "Live" } as Project;

beforeEach(() => useStore.setState({ slug: "acme" }));

function Address() {
  const { pathname, search } = useLocation();
  return <output aria-label="address">{pathname + search}</output>;
}

const press = (target: Element = document.body) =>
  act(() => void fireEvent.keyDown(target, { key: "b", code: "KeyB", metaKey: true }));

describe("Cmd+B", () => {
  it("takes a project's list to its board and back, keeping the filters in the address", () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={["/acme/p/SVA/tasks?status=Todo"]}>
        <LayoutTabs layout="list" routeProject={project} onChange={() => {}} />
        <Address />
      </MemoryRouter>,
    );
    press();
    expect(screen.getByLabelText("address").textContent).toBe("/acme/p/SVA/board?status=Todo");
    // The page the address leads to draws the tabs again, with the board on.
    rerender(
      <MemoryRouter>
        <LayoutTabs layout="board" routeProject={project} onChange={() => {}} />
        <Address />
      </MemoryRouter>,
    );
    press();
    expect(screen.getByLabelText("address").textContent).toBe("/acme/p/SVA/tasks?status=Todo");
  });

  it("switches a saved view's layout in its state", () => {
    const change = vi.fn();
    render(
      <MemoryRouter>
        <LayoutTabs layout="board" routeProject={undefined} onChange={change} />
      </MemoryRouter>,
    );
    press();
    expect(change).toHaveBeenCalledWith("list");
  });

  it("leaves Cmd+B to a field that has the caret", () => {
    const change = vi.fn();
    render(
      <MemoryRouter>
        <LayoutTabs layout="list" routeProject={undefined} onChange={change} />
        <textarea aria-label="field" />
      </MemoryRouter>,
    );
    press(screen.getByLabelText("field"));
    expect(change).not.toHaveBeenCalled();
  });
});

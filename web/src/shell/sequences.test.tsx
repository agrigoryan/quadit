// @vitest-environment jsdom
// The app's two-key sequences (shell/sequences.tsx): G then a letter goes to
// a place, M then a letter relates the open task to another while one is
// open, both through the one listener, and a card lists what can follow.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/data/store";
import { useRelationKeys } from "@/detail/relation-keys";
import { SequenceHint, useSequences } from "@/shell/sequences";

function Shell() {
  useSequences();
  return (
    <>
      <output aria-label="address">{useLocation().pathname}</output>
      <SequenceHint />
    </>
  );
}

function renderShell() {
  render(
    <MemoryRouter initialEntries={["/acme/my-work"]}>
      <Shell />
    </MemoryRouter>,
  );
}

/** Presses a key on the page; returns whether something used it up. */
const press = (key: string) => {
  let used = false;
  act(() => void (used = !fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}` })));
  return used;
};

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({ slug: "acme" });
});

afterEach(() => {
  vi.useRealTimers();
  useRelationKeys.setState({ relate: null });
});

describe("the sequences", () => {
  it("relate the open task: M then B, X, R or M asks for that kind of relation", () => {
    const relate = vi.fn();
    useRelationKeys.setState({ relate });
    renderShell();
    for (const letter of ["b", "x", "r", "m"]) {
      press("m");
      expect(press(letter)).toBe(true);
    }
    expect(relate.mock.calls).toEqual([["blocked_by"], ["blocks"], ["relates"], ["duplicates"]]);
  });

  it("leave M alone while no task is open: the letter after it is not used up", () => {
    renderShell();
    press("m");
    expect(press("b")).toBe(false);
  });

  it("go on going to places with G while M is a sequence too", () => {
    useRelationKeys.setState({ relate: vi.fn() });
    renderShell();
    press("g");
    press("i");
    expect(screen.getByLabelText("address")).toHaveTextContent("/acme/inbox");
  });

  it("show a card a moment after M, with each letter and the relation it adds", () => {
    useRelationKeys.setState({ relate: vi.fn() });
    renderShell();
    press("m");
    act(() => void vi.advanceTimersByTime(300));
    const card = screen.getByRole("status", { name: "Relate to another task" });
    expect(card).toHaveTextContent("BMark as blocked by a task");
    expect(card).toHaveTextContent("MMark as a duplicate of a task");
  });
});

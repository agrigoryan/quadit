// @vitest-environment jsdom
// Cmd+Shift+Up and Down on the open task (detail/family-keys.ts): up to its
// parent, down to its first sub-task, as their links open them; never from
// a field, where the keys choose text.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyCollections } from "@/data/collections";
import { useStore } from "@/data/store";
import type { Task } from "@/types/core";
import { useFamilyKeys } from "@/detail/family-keys";

const task = (n: number, fields: Partial<Task> = {}) =>
  ({
    id: `t${n}`,
    project_id: "p",
    number: n,
    key: `SVA-${n}`,
    title: `Task ${n}`,
    rank: String(n),
    ...fields,
  }) as Task;

const tasks = [task(1), task(2, { parent_id: "t1", rank: "9" }), task(3, { parent_id: "t1", rank: "5" }), task(4)];

beforeEach(() => {
  useStore.setState({
    slug: "acme",
    collections: { ...emptyCollections(), tasks: Object.fromEntries(tasks.map((tk) => [tk.id, tk])) },
  });
});

function Open({ id }: { id: string }) {
  useFamilyKeys(useStore.getState().collections.tasks[id] as Task);
  return (
    <>
      <input aria-label="field" />
      <output aria-label="address">{useLocation().pathname}</output>
    </>
  );
}

function open(id: string) {
  render(
    <MemoryRouter initialEntries={[`/acme/task/SVA-${id.slice(1)}`]}>
      <Open id={id} />
    </MemoryRouter>,
  );
}

const press = (key: string, target: Element = document.body) =>
  act(() => void fireEvent.keyDown(target, { key, code: key, metaKey: true, shiftKey: true }));
const address = () => screen.getByLabelText("address").textContent;

describe("useFamilyKeys", () => {
  it("opens the parent with Cmd+Shift+Up", () => {
    open("t3");
    press("ArrowUp");
    expect(address()).toBe("/acme/task/SVA-1");
  });

  it("opens the first sub-task, by rank, with Cmd+Shift+Down", () => {
    open("t1");
    press("ArrowDown");
    expect(address()).toBe("/acme/task/SVA-3");
  });

  it("goes nowhere without a parent or a sub-task, nor from a field", () => {
    open("t4");
    press("ArrowUp");
    press("ArrowDown");
    expect(address()).toBe("/acme/task/SVA-4");
  });

  it("leaves the keys to a field that has the caret", () => {
    open("t3");
    press("ArrowUp", screen.getByLabelText("field"));
    expect(address()).toBe("/acme/task/SVA-3");
  });
});

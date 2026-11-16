// @vitest-environment jsdom
// A view's filters (docs/db/filter-editor.tsx) have no id of their own. A
// row's text box, and the value it waits to save, stay with its filter when
// a filter above it is taken away.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import { getRow, useRow } from "@/data/selectors";
import { clearStore, loadBootstrap, mergeRows } from "@/data/store";
import { FilterEditor } from "@/docs/db/filter-editor";
import type { Member, User, Workspace } from "@/types/core";
import type { DBView } from "@/types/docs";

const view: DBView = {
  id: "v1",
  database_id: "db1",
  name: "Table",
  type: "table",
  rank: "a",
  config: {
    filters: [
      { prop: "title", op: "contains", value: "one" },
      { prop: "title", op: "contains", value: "two" },
      { prop: "title", op: "contains", value: "three" },
    ],
  },
};

function Editor() {
  const now = useRow("dbviews", "v1");
  return now ? <FilterEditor view={now} props={[]} /> : null;
}

const boxes = () => screen.getAllByRole<HTMLInputElement>("textbox", { name: "Value" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(api, "post").mockReturnValue(new Promise(() => {}));
  clearStore();
  loadBootstrap("acme", {
    seq: 10,
    me: { user_id: "u1" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
  });
  mergeRows("dbviews", [view]);
});

afterEach(async () => {
  await clearOutbox();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the filter editor", () => {
  it("keeps a value being typed with its filter when a filter above it is taken away, and saves it there", async () => {
    render(<Editor />);
    fireEvent.change(boxes()[2] as HTMLInputElement, { target: { value: "three and more" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove filter" })[0] as HTMLElement);

    expect(boxes().map((box) => box.value)).toEqual(["two", "three and more"]);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getRow("dbviews", "v1")?.config?.filters).toEqual([
      { prop: "title", op: "contains", value: "two" },
      { prop: "title", op: "contains", value: "three and more" },
    ]);
  });

  it("does not save a value waiting in a filter taken away into the filter that takes its place", async () => {
    render(<Editor />);
    fireEvent.change(boxes()[0] as HTMLInputElement, { target: { value: "one and more" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove filter" })[0] as HTMLElement);

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getRow("dbviews", "v1")?.config?.filters).toEqual([
      { prop: "title", op: "contains", value: "two" },
      { prop: "title", op: "contains", value: "three" },
    ]);
    expect(boxes().map((box) => box.value)).toEqual(["two", "three"]);
  });
});

// @vitest-environment jsdom
// A database page (docs/db/database-page.tsx): for a read-only member one
// with no views yet shows its rows in a table nobody saved, rather than
// waiting for a view that only someone who may change it would make; and
// its keys: Cmd+B between its table and its board, N a new row, and J/K
// and Enter on the row open beside it. A date typed into a cell's picker is
// kept when the person leaves the cell, by a click elsewhere or by Tab, as a
// typed value is in any other cell.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import DatabaseView from "@/docs/db/database-page";
import { useDocsStore } from "@/docs/store";
import { emptyCollections } from "@/data/collections";
import { useStore } from "@/data/store";
import { formatDay } from "@/lib/time";
import type { DBProperty, DBView, Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const doc = (fields: Partial<Doc>) =>
  ({
    title: "",
    rank: "a",
    created_at: 0,
    updated_at: 0,
    updated_seq: 1,
    ...fields,
  }) as Doc; // only the fields a table reads

const database = doc({ id: "db1", kind: "database", title: "Tools" });
const rows = {
  r1: doc({
    id: "r1",
    parent_id: "db1",
    kind: "row",
    title: "Hammer",
    rank: "a",
  }),
  r2: doc({ id: "r2", parent_id: "db1", kind: "row", title: "Saw", rank: "b" }),
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
  useStore.setState({
    slug: "acme",
    me: { user_id: "u1", role: "member" } as ReturnType<typeof useStore.getState>["me"],
    collections: {
      ...emptyCollections(),
      docs: { db1: database, ...rows },
    },
  });
  useDocsStore.setState({ meta: { db1: { mentioned_in: [], mentions: [] } } });
});

describe("DatabaseView", () => {
  it("shows a read-only member the rows of a database with no views, in a table", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <DatabaseView doc={database} readOnly />
        </TooltipProvider>
      </MemoryRouter>,
      { wrapper: WithQuery },
    );
    expect(screen.getByRole("grid", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByText("Hammer")).toBeInTheDocument();
  });
});

const views: DBView[] = [
  { id: "v1", database_id: "db1", name: "Table", type: "table", rank: "a" },
  { id: "v2", database_id: "db1", name: "Board", type: "board", rank: "b" },
];

function Address() {
  const { pathname, search } = useLocation();
  return <output aria-label="address">{pathname + search}</output>;
}

/** The database as one who may change it sees it, with a table and a board, at this address. */
function open(at = "/acme/docs/db1") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <TooltipProvider>
        <DatabaseView doc={database} readOnly={false} />
        <Address />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const press = (key: string, code: string, more: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(document.body, { key, code, ...more }));
const address = () => screen.getByLabelText("address").textContent;

describe("the keys of a database", () => {
  beforeEach(() => {
    vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve({
        results: (body as { changes: unknown[] }).changes.map(() => ({})),
      }),
    );
    useStore.setState((s) => ({
      collections: {
        ...s.collections,
        docs: { db1: database, ...rows },
        dbviews: Object.fromEntries(views.map((v) => [v.id, v])),
      },
    }));
  });

  afterEach(async () => {
    await clearOutbox();
    vi.restoreAllMocks();
  });

  it("switch between its table and its board with Cmd+B", () => {
    open();
    expect(screen.getByRole("grid", { name: "Table" })).toBeInTheDocument();
    press("b", "KeyB", { metaKey: true });
    expect(address()).toBe("/acme/docs/db1?v=v2");
    expect(screen.queryByRole("grid")).toBeNull();
    press("b", "KeyB", { metaKey: true });
    expect(address()).toBe("/acme/docs/db1?v=v1");
  });

  it("make a row with N and open it beside the table", () => {
    open();
    press("n", "KeyN");
    const made = Object.values(useStore.getState().collections.docs).filter((d) => !(d.id in rows) && d.id !== "db1");
    expect(made).toHaveLength(1);
    expect(made[0]?.parent_id).toBe("db1");
    expect(address()).toBe(`/acme/docs/db1?peek=${made[0]?.id}`);
  });

  it("step the row open beside it with J and K, in the view's order, and open it as a page with Enter", () => {
    open("/acme/docs/db1?peek=r1");
    press("j", "KeyJ");
    expect(address()).toBe("/acme/docs/db1?peek=r2");
    press("j", "KeyJ");
    expect(address()).toBe("/acme/docs/db1?peek=r2");
    press("ArrowUp", "ArrowUp");
    expect(address()).toBe("/acme/docs/db1?peek=r1");
    press("Enter", "Enter");
    expect(address()).toBe("/acme/docs/r1");
  });

  it("step the row from a chosen cell with J under Caps Lock, and leave Shift+J to typing into the cell", () => {
    open("/acme/docs/db1?peek=r1");
    const grid = screen.getByRole("grid", { name: "Table" });
    act(() => grid.focus());
    act(() => void fireEvent.keyDown(grid, { key: "J", code: "KeyJ" }));
    expect(address()).toBe("/acme/docs/db1?peek=r2");
    act(() => void fireEvent.keyDown(grid, { key: "J", code: "KeyJ", shiftKey: true }));
    expect(address()).toBe("/acme/docs/db1?peek=r2");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("J");
  });

  it("open the row beside as a page with Enter from a chosen cell, as a click on Open leaves the table", () => {
    open("/acme/docs/db1?peek=r1");
    const grid = screen.getByRole("grid", { name: "Table" });
    act(() => grid.focus());
    act(() => void fireEvent.keyDown(grid, { key: "j", code: "KeyJ" }));
    act(() => void fireEvent.keyDown(grid, { key: "Enter", code: "Enter" }));
    expect(address()).toBe("/acme/docs/r2");
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });
});

describe("a date typed into a table's cell", () => {
  const due: DBProperty = { id: "due", database_id: "db1", name: "Due", type: "date", rank: "a" };
  const dueOf = (id: string) => useStore.getState().collections.docs[id]?.props?.due;

  beforeEach(() => {
    vi.spyOn(api, "post").mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
    );
    useStore.setState((s) => ({
      collections: {
        ...s.collections,
        docs: { db1: database, r1: { ...rows.r1, props: { due: "2026-12-01" } }, r2: rows.r2 },
        dbviews: { v1: views[0] as DBView },
        properties: { due },
      },
    }));
  });

  afterEach(async () => {
    await clearOutbox();
    vi.restoreAllMocks();
  });

  /** Opens r1's date in its picker and types into its box. */
  async function typeInto(words: string) {
    open();
    fireEvent.click(screen.getByText(formatDay("2026-12-01")));
    const picker = screen.getByRole("dialog", { name: "Due" });
    const box = within(picker).getByRole("textbox", { name: "Due" });
    fireEvent.change(box, { target: { value: words } });
    // The picker hears a click outside it a moment after it opens.
    await act(() => new Promise((done) => setTimeout(done, 0)));
    return { picker, box };
  }

  it("is kept when another cell is clicked", async () => {
    const { picker } = await typeInto("2026-12-05");
    const other = screen.getByText("Saw");
    fireEvent.pointerDown(other);
    fireEvent.mouseDown(other);
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(dueOf("r1")).toBe("2026-12-05");
  });

  it("is kept by Tab, which goes on to the next cell", async () => {
    const { picker, box } = await typeInto("2026-12-05");
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(dueOf("r1")).toBe("2026-12-05");
    expect(screen.getByRole("gridcell", { selected: true })).toHaveAttribute("data-cell", "r2:title");
  });

  it("is given up by Escape", async () => {
    const { picker, box } = await typeInto("2026-12-05");
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(dueOf("r1")).toBe("2026-12-01");
  });
});

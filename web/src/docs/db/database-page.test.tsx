// @vitest-environment jsdom
// A database page (docs/db/database-page.tsx): for a read-only member one
// with no views yet shows its rows in a table nobody saved, rather than
// waiting for a view that only someone who may change it would make; and
// Cmd+B between its table and its board.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { clearOutbox } from "@/data/mutate";
import DatabaseView from "@/docs/db/database-page";
import { useDocsStore } from "@/docs/store";
import { emptyCollections } from "@/data/collections";
import { useStore } from "@/data/store";
import type { DBView, Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const doc = (fields: Partial<Doc>) =>
  ({ title: "", rank: "a", created_at: 0, updated_at: 0, updated_seq: 1, ...fields }) as Doc; // only the fields a table reads

const database = doc({ id: "db1", kind: "database", title: "Tools" });
const rows = {
  r1: doc({ id: "r1", parent_id: "db1", kind: "row", title: "Hammer", rank: "a" }),
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
      Promise.resolve({ results: (body as { changes: unknown[] }).changes.map(() => ({})) }),
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
});

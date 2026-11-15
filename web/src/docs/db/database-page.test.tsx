// @vitest-environment jsdom
// A database page (docs/db/database-page.tsx) for a read-only member: one
// with no views yet shows its rows in a table nobody saved, rather than
// waiting for a view that only someone who may change it would make.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import DatabaseView from "@/docs/db/database-page";
import { useDocsStore } from "@/docs/store";
import { emptyCollections } from "@/data/collections";
import { useStore } from "@/data/store";
import type { Doc } from "@/types/docs";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const doc = (fields: Partial<Doc>) =>
  ({ title: "", rank: "a", created_at: 0, updated_at: 0, updated_seq: 1, ...fields }) as Doc; // only the fields a table reads

const database = doc({ id: "db1", kind: "database", title: "Tools" });

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
      docs: { db1: database, r1: doc({ id: "r1", parent_id: "db1", kind: "row", title: "Hammer" }) },
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

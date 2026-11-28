// @vitest-environment jsdom
// How a task page's filters and its address follow each other (tasks/page-state.ts).

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { emptyFilters } from "@/tasks/filters";
import type { QuerySource } from "@/tasks/properties/property";
import { usePageState } from "@/tasks/page-state";

const tables: QuerySource = { projects: {}, members: {}, statuses: {}, labels: {}, epics: {}, cycles: {} };

/** A task page at `address`, and the address as it stands. */
function page(scope: string, address: string) {
  return renderHook(
    () => ({
      page: usePageState({ scope, saved: null, tables, project: undefined, routeLayout: undefined }),
      search: useLocation().search,
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[address]}>{children}</MemoryRouter>
      ),
    },
  );
}

describe("usePageState", () => {
  it("starts from the filters in the address", () => {
    const { result } = page("starts", "/tasks?q=boss");
    expect(result.current.page.state.filters.text).toBe("boss");
  });

  it("writes a changed filter into the address", () => {
    const { result } = page("writes", "/tasks");
    act(() => result.current.page.setFilters({ ...emptyFilters, text: "boss" }));
    expect(result.current.search).toBe("?q=boss");
  });

  it("keeps a space typed at the end of the search text, which the address does not carry", () => {
    const { result } = page("space", "/tasks");
    // Typed faster than the address follows: both keys land before the page is drawn again.
    act(() => {
      result.current.page.setFilters({ ...emptyFilters, text: "number" });
      result.current.page.setFilters({ ...emptyFilters, text: "number " });
    });
    expect(result.current.search).toBe("?q=number");
    expect(result.current.page.state.filters.text).toBe("number ");
  });
});

// Every change type the server knows, and the version of that list (the
// "agent surface"). It is the same for the whole install, not one workspace,
// and changes only with the server, so it is read once.

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

export interface ChangeCatalog {
  /** The version of what agents can call. */
  surface: string;
  /** Every change type, sorted. */
  types: string[];
}

export const changeCatalogQuery = queryOptions({
  queryKey: ["install", "changes"],
  queryFn: ({ signal }) =>
    api
      .get<{ surface?: string; changes: { type: string }[] }>("/api/v1/changes", signal)
      .then((r): ChangeCatalog => ({ surface: r.surface ?? "", types: r.changes.map((c) => c.type).sort() })),
  staleTime: Infinity,
});

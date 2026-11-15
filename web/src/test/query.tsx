// The app's query client (lib/query.ts) for a test of what reads through it:
// a failed read shows at once instead of being tried again, and nothing a
// test fetched is left for the next one.
//
//   renderHook(() => useFindTask("SVA-9", false), { wrapper: WithQuery });
//   render(<TokensPage />, { wrapper: WithQuery });

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach } from "vitest";
import { queryClient } from "@/lib/query";

queryClient.setDefaultOptions({
  ...queryClient.getDefaultOptions(),
  queries: { ...queryClient.getDefaultOptions().queries, retry: false },
});

afterEach(() => queryClient.clear());

export function WithQuery({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

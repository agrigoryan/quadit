// @vitest-environment jsdom
// The page's editor (docs/editor/editor.tsx) keeps one sync with the server
// for as long as the page is open: the page turning read-only, or editable
// again, does not start another from the blocks fetched when it opened.

import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import Editor from "@/docs/editor/editor";
import { DocSync } from "@/docs/editor/sync";
import type { BlockRow } from "@/lib/types-docs";

vi.mock("@/docs/editor/sync", () => ({
  DocSync: vi.fn(
    class {
      flush() {}
      destroy() {}
    },
  ),
}));

beforeAll(() => {
  // BlockNote's view asks for the colour scheme and measures itself; jsdom does neither.
  window.matchMedia ??= (query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList; // jsdom has none: a stand-in with what BlockNote calls
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const rows: BlockRow[] = [
  {
    id: "b1",
    doc_id: "d1",
    rank: "a",
    type: "paragraph",
    content: [{ type: "text", text: "Hello", styles: {} }],
    created_by: "u1",
    updated_by: "u1",
    created_seq: 1,
    updated_seq: 1,
  },
];

describe("Editor", () => {
  it("keeps its sync when the page turns read-only and back", () => {
    const { rerender } = render(<Editor docId="d1" rows={rows} seq={1} readOnly={false} />);
    rerender(<Editor docId="d1" rows={rows} seq={1} readOnly />);
    rerender(<Editor docId="d1" rows={rows} seq={1} readOnly={false} />);
    expect(DocSync).toHaveBeenCalledTimes(1);
  });
});

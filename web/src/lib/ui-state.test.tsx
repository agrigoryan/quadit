// @vitest-environment jsdom
// The browser tab's name (usePageTitle in lib/ui-state.ts): a page that goes
// away takes its name with it, and the page still showing names the tab again.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePageTitle } from "@/lib/ui-state";

function Titled({ title, children }: { title: string; children?: React.ReactNode }) {
  usePageTitle(title);
  return <>{children}</>;
}

describe("usePageTitle", () => {
  it("gives the tab back to the page around a page that leaves (a not-found page inside Settings)", () => {
    const { rerender } = render(<Titled title="Settings" />);
    expect(document.title).toBe("Settings – Quadit");
    rerender(
      <Titled title="Settings">
        <Titled title="There is nothing at this address" />
      </Titled>,
    );
    expect(document.title).toBe("There is nothing at this address – Quadit");
    rerender(<Titled title="Settings" />);
    expect(document.title).toBe("Settings – Quadit");
  });

  it("names the tab after a page that changes its name", () => {
    const { rerender, unmount } = render(<Titled title="Release" />);
    rerender(<Titled title="Release v2" />);
    expect(document.title).toBe("Release v2 – Quadit");
    unmount();
    expect(document.title).toBe("Quadit");
  });
});

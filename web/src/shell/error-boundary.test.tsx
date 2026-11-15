// @vitest-environment jsdom
// A fault in a page or a part stays there, and going elsewhere clears it (shell/error-boundary.tsx).

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageBoundary, PartBoundary } from "@/shell/error-boundary";

function Page({ broken }: { broken: boolean }) {
  if (broken) throw new Error("the page broke");
  return <p>the page</p>;
}

describe("PageBoundary", () => {
  it("shows the fault in place of the page until the person goes to another page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <PageBoundary resetKey="/a">
        <Page broken />
      </PageBoundary>,
    );
    expect(screen.getByText("the page broke")).toBeInTheDocument();

    // The same page drawn again (the cause gone, the address the same) still shows the fault.
    rerender(
      <PageBoundary resetKey="/a">
        <Page broken={false} />
      </PageBoundary>,
    );
    expect(screen.getByText("the page broke")).toBeInTheDocument();

    rerender(
      <PageBoundary resetKey="/b">
        <Page broken={false} />
      </PageBoundary>,
    );
    expect(screen.queryByText("the page broke")).toBeNull();
    expect(screen.getByText("the page")).toBeInTheDocument();
  });
});

describe("PartBoundary", () => {
  it("leaves a failed part out until it is asked for again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <PartBoundary resetKey="true">
        <Page broken />
      </PartBoundary>,
    );
    expect(screen.queryByText("the page")).toBeNull();
    rerender(
      <PartBoundary resetKey="true">
        <Page broken={false} />
      </PartBoundary>,
    );
    expect(screen.queryByText("the page")).toBeNull();
    rerender(
      <PartBoundary resetKey="false">
        <Page broken={false} />
      </PartBoundary>,
    );
    expect(screen.getByText("the page")).toBeInTheDocument();
  });
});

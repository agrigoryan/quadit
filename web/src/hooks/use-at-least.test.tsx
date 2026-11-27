// @vitest-environment jsdom
// Whether an element is wide enough (hooks/use-at-least.ts): known at once,
// followed as it is resized, and once wide kept so until it is narrower by
// the slack given, so a scrollbar the wide layout brings does not undo it.
// The element's width is the test's (jsdom lays nothing out; spies are
// put back after each test, so each sets its own).

import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAtLeast } from "@/hooks/use-at-least";

let width = 0;
let resized = () => {};

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

function Box() {
  const el = useRef<HTMLDivElement>(null);
  const wide = useAtLeast(el, 50, 1);
  return <div ref={el}>{wide ? "wide" : "narrow"}</div>;
}

const resize = (px: number) =>
  act(() => {
    width = px;
    resized();
  });

describe("useAtLeast", () => {
  it("says at once whether the element is wide enough, and follows it as it is resized", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    width = 50 * 16;
    render(<Box />);
    expect(screen.getByText("wide")).toBeInTheDocument();
    resize(40 * 16);
    expect(screen.getByText("narrow")).toBeInTheDocument();
  });

  it("stays wide until the element is narrower by the slack, and turns wide again only at the full width", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    width = 50 * 16;
    render(<Box />);
    resize(50 * 16 - 15);
    expect(screen.getByText("wide")).toBeInTheDocument();
    resize(49 * 16 - 1);
    expect(screen.getByText("narrow")).toBeInTheDocument();
    resize(50 * 16 - 15);
    expect(screen.getByText("narrow")).toBeInTheDocument();
    resize(50 * 16);
    expect(screen.getByText("wide")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
// Escape goes back from a page of its own (nav/escape-back.ts).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { useEscapeBack } from "@/nav/escape-back";

function Epic({ enabled }: { enabled: boolean }) {
  useEscapeBack("/acme/p/SVA/epics", enabled);
  return <input aria-label="field" />;
}

function Address() {
  return <output aria-label="address">{useLocation().pathname}</output>;
}

function show(enabled = true) {
  render(
    <MemoryRouter initialEntries={["/acme/p/SVA/epics/e1"]}>
      <Routes>
        <Route path="/acme/p/SVA/epics/e1" element={<Epic enabled={enabled} />} />
        <Route path="*" element={null} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
}

const escape = (target: Element = document.body) => act(() => void fireEvent.keyDown(target, { key: "Escape" }));
const address = () => screen.getByLabelText("address").textContent;

describe("useEscapeBack", () => {
  it("goes to the page's list when there is no step to go back to", () => {
    show();
    escape();
    expect(address()).toBe("/acme/p/SVA/epics");
  });

  it("leaves Escape to a field being typed in", () => {
    show();
    escape(screen.getByLabelText("field"));
    expect(address()).toBe("/acme/p/SVA/epics/e1");
  });

  it("does nothing while it is turned off (a column beside the page is open)", () => {
    show(false);
    escape();
    expect(address()).toBe("/acme/p/SVA/epics/e1");
  });
});

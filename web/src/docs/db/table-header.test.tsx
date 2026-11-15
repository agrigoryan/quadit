// @vitest-environment jsdom
// A column's resize handle (docs/db/table-header.tsx) is a window splitter
// the keyboard can move: a Tab stop that says its width and its bounds, Left
// and Right narrow and widen it, Shift for bigger steps.

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HeaderCell } from "@/docs/db/table-header";
import type { DBProperty, DBView } from "@/lib/types-docs";
import { TooltipProvider } from "@/ui/tooltip";

const prop = { id: "p1", name: "Owner", type: "text" } as DBProperty;
const view = { id: "v1", database_id: "d1", name: "Table", type: "table", rank: "a" } as DBView;

/** A header whose width follows its handle, as the table's does; `saved` gets each width that is let go. */
function Header({ saved }: { saved: (width: number) => void }) {
  const [width, setWidth] = useState(160);
  return (
    <TooltipProvider>
      <HeaderCell
        prop={prop}
        view={view}
        width={width}
        open={false}
        onOpenChange={() => {}}
        onResize={(next, done) => {
          setWidth(next);
          if (done) saved(next);
        }}
        readOnly={false}
      />
    </TooltipProvider>
  );
}

describe("a column's resize handle", () => {
  it("is a focusable vertical separator that says the column's width", () => {
    render(<Header saved={() => {}} />);
    const handle = screen.getByRole("separator", { name: "Resize Owner" });
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "160");
    expect(handle).toHaveAttribute("aria-valuemin", "72");
    expect(handle).toHaveAttribute("aria-valuemax");
  });

  it("widens with Right and narrows with Left, by more with Shift, and keeps the width once the key is let go", () => {
    const saved = vi.fn();
    render(<Header saved={saved} />);
    const handle = screen.getByRole("separator", { name: "Resize Owner" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "170");
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(saved).toHaveBeenLastCalledWith(170);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyUp(handle, { key: "ArrowLeft", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "120");
    expect(saved).toHaveBeenLastCalledWith(120);
  });

  it("goes no narrower than its least width", () => {
    render(<Header saved={() => {}} />);
    const handle = screen.getByRole("separator", { name: "Resize Owner" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "72");
  });
});

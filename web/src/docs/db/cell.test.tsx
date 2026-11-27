// @vitest-environment jsdom
// A database's date value (docs/db/cell.tsx) is changed in the date picker,
// which opens beside the cell: a day typed or picked is stored as YYYY-MM-DD,
// and Clear empties the cell.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelfCell } from "@/docs/db/cell";
import { formatDay } from "@/lib/time";
import type { DBProperty } from "@/types/docs";
import { TooltipProvider } from "@/ui/tooltip";

const due: DBProperty = { id: "due", database_id: "db1", name: "Due", type: "date", rank: "a" };

function cell(stored: string) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <SelfCell prop={due} stored={stored} shown={stored} onChange={onChange} />
    </TooltipProvider>,
  );
  // The mouse's way in: a click on the value.
  fireEvent.click(screen.getByText(formatDay(stored)));
  return { onChange, picker: screen.getByRole("dialog", { name: "Due" }) };
}

describe("a date cell", () => {
  it("stores the day typed in the date picker", () => {
    const { onChange, picker } = cell("2026-12-01");
    const box = within(picker).getByRole("textbox", { name: "Due" });
    fireEvent.change(box, { target: { value: "dec 5 2026" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-12-05");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is emptied by Clear", () => {
    const { onChange, picker } = cell("2026-12-01");
    fireEvent.click(within(picker).getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

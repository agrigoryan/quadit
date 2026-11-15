// @vitest-environment jsdom
// PickerList (ui/picker.tsx): typing narrows the list, arrows and Enter pick,
// a name that is not there yet can be made, and the last row leads to where
// the choices are managed. Picker closes on a pick unless several can be picked.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Picker, type PickerItem, PickerList } from "@/ui/picker";

beforeAll(() => {
  // cmdk scrolls the active row into view and measures the list; jsdom does neither.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const labels: PickerItem[] = [
  { id: "l1", label: "Bug" },
  { id: "l2", label: "Feature", keywords: "idea" },
  { id: "l3", label: "Chore" },
];

const search = () => screen.getByRole("combobox");
const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
const key = (k: string) => fireEvent.keyDown(search(), { key: k });

describe("PickerList", () => {
  it("is a named listbox of options, searched from a box that has the focus", () => {
    render(<PickerList label="Labels" items={labels} value={["l2"]} onPick={() => {}} />);
    expect(screen.getByRole("listbox", { name: "Labels" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Labels" })).toHaveFocus();
    expect(options().map((o) => o.textContent)).toEqual(["Bug", "Feature", "Chore"]);
  });

  it("narrows to what is typed, by label or keyword", () => {
    render(<PickerList label="Labels" items={labels} onPick={() => {}} />);
    type("ide");
    expect(options().map((o) => o.textContent)).toEqual(["Feature"]);
    type("zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("moves with the arrows, wraps around, and picks with Enter", () => {
    const onPick = vi.fn();
    render(<PickerList label="Labels" items={labels} onPick={onPick} />);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    key("ArrowDown");
    key("ArrowDown");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    key("ArrowDown");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    key("ArrowUp");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("l3");
  });

  it("offers to make a name that is not there, and makes it with Enter", () => {
    const onCreate = vi.fn();
    render(
      <PickerList
        label="Labels"
        items={labels}
        onPick={() => {}}
        onCreate={onCreate}
        createLabel={(name) => `Create label “${name}”`}
      />,
    );
    type("bug");
    expect(screen.queryByRole("option", { name: /Create label/ })).toBeNull();
    type("  Urgent ");
    const offer = screen.getByRole("option", { name: "Create label “Urgent”" });
    expect(offer).toHaveAttribute("aria-selected", "true");
    key("Enter");
    expect(onCreate).toHaveBeenCalledWith("Urgent");
    expect(search()).toHaveValue("");
  });

  it("leads to where the choices are managed from its last row", () => {
    const onSelect = vi.fn();
    render(
      <PickerList label="Labels" items={labels} onPick={() => {}} manage={{ label: "Manage labels", onSelect }} />,
    );
    key("ArrowUp");
    expect(screen.getByRole("option", { name: "Manage labels" })).toHaveAttribute("aria-selected", "true");
    key("Enter");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("draws each row with the row renderer when given one", () => {
    render(
      <PickerList label="Options" items={labels} onPick={() => {}} row={(item) => <b>{item.label.toUpperCase()}</b>} />,
    );
    expect(options().map((o) => o.textContent)).toEqual(["BUG", "FEATURE", "CHORE"]);
  });
});

describe("Picker", () => {
  it("closes on a pick, and on the way to managing the choices", () => {
    const onPick = vi.fn();
    const onSelect = vi.fn();
    render(
      <Picker label="Labels" items={labels} onPick={onPick} manage={{ label: "Manage labels", onSelect }}>
        <button type="button">Open</button>
      </Picker>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("option", { name: "Bug" }));
    expect(onPick).toHaveBeenCalledWith("l1");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("option", { name: "Manage labels" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open for several picks, and empties the search after each", () => {
    const onPick = vi.fn();
    render(
      <Picker multiple label="Labels" items={labels} onPick={onPick}>
        <button type="button">Open</button>
      </Picker>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    type("bu");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("l1");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(search()).toHaveValue("");
  });
});

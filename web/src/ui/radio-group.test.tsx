// @vitest-environment jsdom
// A set of choices drawn as buttons (ui/radio-group.tsx) behaves as a radio
// group: one Tab stop on the picked choice, arrows move and pick, Home and
// End go to the ends.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Radio, RadioGroup } from "@/ui/radio-group";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Sizes({ start = "medium" }: { start?: string }) {
  const [size, setSize] = useState(start);
  return (
    <RadioGroup label="Size" value={size} onChange={setSize}>
      {["small", "medium", "large"].map((s) => (
        <Radio key={s} value={s}>
          {s}
        </Radio>
      ))}
    </RadioGroup>
  );
}

/** A quick key press, as a script or some assistive technology makes it: the key is up before the focus moves. */
function press(key: string) {
  const target = document.activeElement ?? document.body;
  act(() => {
    fireEvent.keyDown(target, { key });
    fireEvent.keyUp(target, { key });
    vi.runAllTimers();
  });
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("a radio group", () => {
  it("is one Tab stop, which lands on the picked choice", () => {
    render(<Sizes />);
    const group = screen.getByRole("radiogroup", { name: "Size" });
    const tabbable = () => [group, ...screen.getAllByRole("radio")].filter((el) => el.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    expect(radio("medium")).toHaveAttribute("aria-checked", "true");
    act(() => tabbable()[0]?.focus());
    expect(radio("medium")).toHaveFocus();
    expect(screen.getAllByRole("radio").filter((el) => el.tabIndex === 0)).toEqual([radio("medium")]);
  });

  it("moves and picks with the arrows, round the ends", () => {
    render(<Sizes />);
    act(() => radio("medium").focus());
    press("ArrowRight");
    expect(radio("large")).toHaveFocus();
    expect(radio("large")).toHaveAttribute("aria-checked", "true");
    press("ArrowDown");
    expect(radio("small")).toHaveFocus();
    expect(radio("small")).toHaveAttribute("aria-checked", "true");
    press("ArrowUp");
    expect(radio("large")).toHaveAttribute("aria-checked", "true");
    press("ArrowLeft");
    expect(radio("medium")).toHaveAttribute("aria-checked", "true");
  });

  it("goes to the first and the last choice with Home and End, and picks it", () => {
    render(<Sizes />);
    act(() => radio("medium").focus());
    press("End");
    expect(radio("large")).toHaveFocus();
    expect(radio("large")).toHaveAttribute("aria-checked", "true");
    press("Home");
    expect(radio("small")).toHaveFocus();
    expect(radio("small")).toHaveAttribute("aria-checked", "true");
  });

  it("picks with a click", () => {
    render(<Sizes />);
    fireEvent.click(radio("small"));
    expect(radio("small")).toHaveAttribute("aria-checked", "true");
    expect(radio("medium")).toHaveAttribute("aria-checked", "false");
  });
});

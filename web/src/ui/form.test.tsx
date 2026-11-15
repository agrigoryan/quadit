// @vitest-environment jsdom
// FormField (ui/form.tsx): the label names its control, the hint describes
// it, and an error replaces the hint, marks the control invalid and is said
// at once. A field with no one control is a named group.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField, NativeSelect } from "@/ui/form";
import { Input, Textarea } from "@/ui/input";

describe("FormField", () => {
  it("names its control and describes it with the hint", () => {
    render(
      <FormField label="Name" htmlFor="n" hint="Shown to everyone">
        <Input id="n" />
      </FormField>,
    );
    const box = screen.getByRole("textbox", { name: "Name" });
    expect(box).toHaveAccessibleDescription("Shown to everyone");
    expect(box).not.toBeInvalid();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts an error in place of the hint, marks the control invalid and announces it", () => {
    render(
      <FormField label="Name" htmlFor="n" hint="Shown to everyone" error="already taken">
        <Textarea id="n" />
      </FormField>,
    );
    const box = screen.getByRole("textbox", { name: "Name" });
    expect(box).toBeInvalid();
    expect(box).toHaveAccessibleDescription("already taken");
    expect(screen.getByRole("alert")).toHaveTextContent("already taken");
    expect(screen.queryByText("Shown to everyone")).toBeNull();
  });

  it("wires a native select the same way", () => {
    render(
      <FormField label="Role" htmlFor="r" error="not allowed">
        <NativeSelect id="r" value="a" onChange={() => {}} options={[{ value: "a", label: "Admin" }]} />
      </FormField>,
    );
    const select = screen.getByRole("combobox", { name: "Role" });
    expect(select).toBeInvalid();
    expect(select).toHaveAccessibleDescription("not allowed");
  });

  it("leaves other controls inside the field alone", () => {
    render(
      <FormField label="Value" htmlFor="v" error="missing">
        <Input id="v" />
        <Input aria-label="Other" />
      </FormField>,
    );
    expect(screen.getByRole("textbox", { name: "Other" })).not.toBeInvalid();
    expect(screen.getByRole("textbox", { name: "Other" })).not.toHaveAccessibleDescription();
  });

  it("is a named, described group when no one control is named", () => {
    render(
      <FormField label="Agents" hint="Everyone when none">
        <button type="button">Add</button>
      </FormField>,
    );
    expect(screen.getByRole("group", { name: "Agents" })).toHaveAccessibleDescription("Everyone when none");
  });
});

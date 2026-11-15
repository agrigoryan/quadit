// @vitest-environment jsdom
// HostInput (settings/secrets/host-input.tsx): the box is named, described
// and marked invalid by the FormField around it, like any other field.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostInput } from "@/settings/secrets/host-input";
import { FormField } from "@/ui/form";

function Field({ error }: { error?: string }) {
  return (
    <FormField label="Hosts" htmlFor="h" hint="One per line" error={error}>
      <HostInput id="h" value={[]} onChange={() => {}} draft="" onDraft={() => {}} onError={() => {}} />
    </FormField>
  );
}

describe("HostInput", () => {
  it("takes its name and description from its field", () => {
    render(<Field />);
    const box = screen.getByRole("textbox", { name: "Hosts" });
    expect(box).toHaveAccessibleDescription("One per line");
    expect(box).not.toBeInvalid();
  });

  it("is marked invalid and described by its field's error", () => {
    render(<Field error="not a host" />);
    const box = screen.getByRole("textbox", { name: "Hosts" });
    expect(box).toBeInvalid();
    expect(box).toHaveAccessibleDescription("not a host");
  });
});

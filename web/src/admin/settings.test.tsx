// @vitest-environment jsdom
// useDraft (admin/settings.ts): the draft starts from the stored value, is
// changed in the form, and starts again from fresh values the server hands
// back.

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { type SettingsMap, SettingsContext, useDraft } from "@/admin/settings";

function Form() {
  const form = useDraft<string>("install.name", "Quadit");
  return (
    <>
      <input aria-label="name" value={form.draft} onChange={(e) => form.set(e.target.value)} />
      <output aria-label="dirty">{String(form.dirty)}</output>
    </>
  );
}

/** The admin frame, with a button that stands for the server handing back fresh settings. */
function Frame({ initial, fresh = {} }: { initial: SettingsMap; fresh?: SettingsMap }) {
  const [settings, setSettings] = useState(initial);
  return (
    <SettingsContext value={{ settings, replace: setSettings }}>
      <Form />
      <button type="button" onClick={() => setSettings(fresh)}>
        fresh
      </button>
    </SettingsContext>
  );
}

describe("useDraft", () => {
  it("starts from the stored value, or the fallback", () => {
    render(<Frame initial={{}} />);
    expect(screen.getByLabelText("name")).toHaveValue("Quadit");
    expect(screen.getByLabelText("dirty")).toHaveTextContent("false");
  });

  it("keeps what is typed until fresh values come back, then starts again from them", () => {
    render(
      <Frame
        initial={{ "install.name": { value: "Acme", from_env: false } }}
        fresh={{ "install.name": { value: "Acme Ltd", from_env: false } }}
      />,
    );
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Acme Inc" } });
    expect(screen.getByLabelText("dirty")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "fresh" }));
    expect(screen.getByLabelText("name")).toHaveValue("Acme Ltd");
    expect(screen.getByLabelText("dirty")).toHaveTextContent("false");
  });
});

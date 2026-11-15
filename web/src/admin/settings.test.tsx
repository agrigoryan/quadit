// @vitest-environment jsdom
// useDraft (admin/settings.ts): the draft starts from the stored value, is
// changed in the form, and starts again from fresh values the server hands
// back.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminKeys } from "@/admin/data";
import { type SettingsMap, useDraft } from "@/admin/settings";
import { queryClient } from "@/lib/query";
import { WithQuery } from "@/test/query";

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
function Frame({ fresh = {} }: { fresh?: SettingsMap }) {
  return (
    <WithQuery>
      <Form />
      <button type="button" onClick={() => queryClient.setQueryData(adminKeys.settings, fresh)}>
        fresh
      </button>
    </WithQuery>
  );
}

/** What the frame waits for: the settings in the query cache, read a moment ago. */
const stored = (settings: SettingsMap) => queryClient.setQueryData(adminKeys.settings, settings);

describe("useDraft", () => {
  it("starts from the stored value, or the fallback", () => {
    stored({});
    render(<Frame />);
    expect(screen.getByLabelText("name")).toHaveValue("Quadit");
    expect(screen.getByLabelText("dirty")).toHaveTextContent("false");
  });

  it("keeps what is typed until fresh values come back, then starts again from them", async () => {
    stored({ "install.name": { value: "Acme", from_env: false } });
    render(<Frame fresh={{ "install.name": { value: "Acme Ltd", from_env: false } }} />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Acme Inc" } });
    expect(screen.getByLabelText("dirty")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "fresh" }));
    await waitFor(() => expect(screen.getByLabelText("name")).toHaveValue("Acme Ltd"));
    expect(screen.getByLabelText("dirty")).toHaveTextContent("false");
  });
});

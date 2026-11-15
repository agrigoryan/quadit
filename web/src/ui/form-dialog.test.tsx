// @vitest-environment jsdom
// FormDialog (ui/form-dialog.tsx): one request per submit, the button off
// while it is out, a refusal in the dialog (on its field when it names one),
// Cancel and Cmd/Ctrl-Enter, and closed once the request goes through.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { FormField, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Input } from "@/ui/input";
import { TooltipProvider } from "@/ui/tooltip";

interface Pending {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** A name form whose every request waits until the test answers it. */
function show() {
  const sent: { name: string; answer: Pending }[] = [];
  const onClose = vi.fn();
  function NameDialog() {
    const [name, setName] = useState("");
    const errors = useFieldErrors(["name"]);
    return (
      <FormDialog
        title="New label"
        submit="Create"
        errors={errors}
        onClose={onClose}
        onSubmit={() => {
          if (!name.trim()) refuse("name", "a name is needed");
          return new Promise<void>((resolve, reject) => sent.push({ name, answer: { resolve, reject } }));
        }}
      >
        <FormField label="Name" htmlFor="name" error={errors.fields.name}>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="Note" htmlFor="note">
          <Input id="note" />
        </FormField>
      </FormDialog>
    );
  }
  render(
    <TooltipProvider>
      <NameDialog />
    </TooltipProvider>,
  );
  return { sent, onClose };
}

const button = () => screen.getByRole("button", { name: "Create" });
const nameBox = () => screen.getByRole("textbox", { name: "Name" });
const type = (text: string) => fireEvent.change(nameBox(), { target: { value: text } });

describe("FormDialog", () => {
  it("starts in the first field", () => {
    show();
    expect(nameBox()).toHaveFocus();
  });

  it("sends once, with the button off while the request is out, and closes when it goes through", async () => {
    const { sent, onClose } = show();
    type("bug");
    fireEvent.click(button());
    expect(button()).toBeDisabled();
    expect(screen.getByRole("dialog").querySelector("form")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button());
    fireEvent.submit(nameBox());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("bug");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => sent[0]?.answer.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal that names no field above the buttons, stays open and lets the person try again", async () => {
    const { sent, onClose } = show();
    type("bug");
    fireEvent.click(button());
    await act(async () => sent[0]?.answer.reject(new ApiError(409, { code: "conflict", message: "out of room" })));
    expect(screen.getByRole("alert")).toHaveTextContent("out of room");
    expect(onClose).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();
    fireEvent.click(button());
    expect(sent).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a refusal that names a field on that field, and says it", async () => {
    const { sent } = show();
    type("bug");
    fireEvent.click(button());
    await act(async () =>
      sent[0]?.answer.reject(new ApiError(409, { code: "conflict", field: "name", message: "already taken" })),
    );
    expect(nameBox()).toBeInvalid();
    expect(nameBox()).toHaveAccessibleDescription("already taken");
    expect(screen.getByRole("alert")).toHaveTextContent("already taken");
  });

  it("stops at a check in the browser before anything is sent", async () => {
    const { sent, onClose } = show();
    await act(async () => fireEvent.click(button()));
    expect(sent).toHaveLength(0);
    expect(nameBox()).toHaveAccessibleDescription("a name is needed");
    expect(onClose).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();
  });

  it("closes on Cancel without sending", () => {
    const { sent, onClose } = show();
    type("bug");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it("sends on Cmd-Enter or Ctrl-Enter from any field", () => {
    const { sent } = show();
    type("bug");
    const note = screen.getByRole("textbox", { name: "Note" });
    fireEvent.keyDown(note, { key: "Enter", metaKey: true });
    expect(sent).toHaveLength(1);
  });

  it("sends on Ctrl-Enter", () => {
    const { sent } = show();
    type("bug");
    fireEvent.keyDown(nameBox(), { key: "Enter", ctrlKey: true });
    expect(sent).toHaveLength(1);
  });
});

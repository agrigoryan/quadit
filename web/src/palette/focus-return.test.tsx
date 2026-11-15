// @vitest-environment jsdom
// useFocusReturn (palette/focus-return.ts): what had the focus before a
// sheet opened, and focused its own box at once, has it back on close.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useFocusReturn } from "@/palette/focus-return";

function Sheet({ open }: { open: boolean }) {
  useFocusReturn(open);
  return open ? <input aria-label="search" autoFocus /> : null;
}

/** Mounted only while open, as the palette is. */
function Palette() {
  useFocusReturn(true);
  return <input aria-label="search" autoFocus />;
}

function Page({ always }: { always: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)}>
        toggle
      </button>
      {always ? <Sheet open={open} /> : open && <Palette />}
    </>
  );
}

describe("useFocusReturn", () => {
  for (const always of [true, false]) {
    it(`gives the focus back on close (${always ? "kept mounted" : "mounted while open"})`, async () => {
      render(<Page always={always} />);
      const toggle = screen.getByRole("button", { name: "toggle" });
      toggle.focus();
      fireEvent.click(toggle);
      expect(screen.getByRole("textbox", { name: "search" })).toHaveFocus();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveFocus());
    });
  }
});

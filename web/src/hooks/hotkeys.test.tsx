// @vitest-environment jsdom
// Single-key shortcuts (hooks/hotkeys.ts): they rest while an overlay is open, and only while it is.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Hotkeys, useHotkeys } from "@/hooks/hotkeys";

function Keys({ keys, overlay }: { keys: Hotkeys; overlay?: "open" | "closed" }) {
  useHotkeys(keys);
  // Radix keeps an overlay on the page, marked closed, while it plays its way out.
  return overlay ? (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- stands in for Radix's overlay, which is a div with the role
    <div role="dialog" aria-label="overlay" data-state={overlay} />
  ) : null;
}

const press = (key: string) => fireEvent.keyDown(document.body, { key });

describe("useHotkeys", () => {
  it("runs a bare key pressed on the page", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} />);
    press("s");
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("leaves a bare key alone while a dialog is open", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} overlay="open" />);
    press("s");
    expect(status).not.toHaveBeenCalled();
  });

  it("runs a bare key while a dialog that has closed is still leaving", () => {
    const status = vi.fn();
    render(<Keys keys={{ s: status }} overlay="closed" />);
    press("s");
    expect(status).toHaveBeenCalledTimes(1);
  });
});

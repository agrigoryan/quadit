// @vitest-environment jsdom
// The shortcuts sheet (palette/shortcuts.tsx) lists the keys the app answers to.

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MOD } from "@/hooks/hotkeys";
import { ui } from "@/lib/ui-state";
import { ShortcutsSheet } from "@/palette/shortcuts";
import { TooltipProvider } from "@/ui/tooltip";

afterEach(() => ui.setShortcuts(false));

describe("ShortcutsSheet", () => {
  it("lists Mod-Enter for opening the chip beside the cursor in a page's text", () => {
    ui.setShortcuts(true);
    render(
      <TooltipProvider>
        <ShortcutsSheet />
      </TooltipProvider>,
    );
    const row = screen.getByText("Open the task, decision, page or person beside the cursor").closest("div");
    expect(row).not.toBeNull();
    // A key cap for each key pressed together.
    const caps = within(row as HTMLElement).getAllByText((_, el) => el?.tagName === "KBD");
    expect(caps.map((cap) => cap.textContent)).toEqual([MOD, "Enter"]);
  });

  it("lists the keys for a task under the lists and under a task alike", () => {
    ui.setShortcuts(true);
    render(
      <TooltipProvider>
        <ShortcutsSheet />
      </TooltipProvider>,
    );
    for (const what of [
      "Assign to me, or take off me",
      "Watch, or stop watching",
      "Change due date",
      "Copy the task's key",
      "Move to the trash",
    ])
      expect(screen.getAllByText(what)).toHaveLength(2);
    for (const what of ["Add a sub-task", "Rename"]) expect(screen.getAllByText(what)).toHaveLength(1);
  });
});

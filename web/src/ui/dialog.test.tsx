// @vitest-environment jsdom
// Dialog (ui/dialog.tsx): it opens in its first field, passing over a file
// input hidden behind its button.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/ui/dialog";
import { TooltipProvider } from "@/ui/tooltip";

describe("Dialog", () => {
  it("starts in the first field, not in a hidden file input before it", () => {
    render(
      <TooltipProvider>
        <Dialog open onOpenChange={() => {}} title="New agent">
          <input type="file" className="hidden" aria-label="Upload a picture" />
          <input aria-label="Name" />
        </Dialog>
      </TooltipProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });
});

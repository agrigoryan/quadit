// @vitest-environment jsdom
// The marks beside a page's blocks (docs/editor/markers.tsx): a block with
// open threads shows how many, at its right; the block the pointer is on,
// with none, offers a new thread in the same place, and keeps offering it
// while the pointer is on the button.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Markers } from "@/docs/editor/markers";
import type { AnyEditor } from "@/docs/editor/sync";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const editor = { onChange: () => () => {} } as unknown as AnyEditor; // only what Markers calls

/** Two blocks, b1 and b2, in the page, as the editor draws them. */
function page() {
  const wrap = createRef<HTMLDivElement>();
  const Page = (props: Partial<Parameters<typeof Markers>[0]>) => (
    <TooltipProvider>
      <div ref={wrap}>
        {["b1", "b2"].map((id) => (
          <div key={id} className="bn-block-outer" data-id={id}>
            <div className="bn-block-content">{id}</div>
          </div>
        ))}
        <Markers editor={editor} wrap={wrap} others={[]} threads={{}} {...props} />
      </div>
    </TooltipProvider>
  );
  return Page;
}

const add = () => screen.queryByRole("button", { name: "Comment on this block" });

describe("Markers", () => {
  it("offers a new thread on the block the pointer is on", async () => {
    const Page = page();
    const onAddThread = vi.fn();
    render(<Page pointed="b2" onAddThread={onAddThread} />);
    const button = await screen.findByRole("button", { name: "Comment on this block" });
    fireEvent.click(button);
    expect(onAddThread).toHaveBeenCalledWith("b2");
  });

  it("shows a block's count of threads in that place instead", async () => {
    const Page = page();
    render(<Page pointed="b1" threads={{ b1: 2 }} onAddThread={() => {}} onOpenThread={() => {}} />);
    expect(await screen.findByRole("button", { name: "2 open comment threads on this block" })).toBeTruthy();
    expect(add()).toBeNull();
  });

  it("offers nothing where no thread may be started", async () => {
    const Page = page();
    const { rerender } = render(<Page pointed="b1" />);
    rerender(<Page threads={{ b2: 1 }} onAddThread={() => {}} onOpenThread={() => {}} />);
    await screen.findByRole("button", { name: "1 open comment thread on this block" });
    expect(add()).toBeNull();
  });

  it("keeps the button while the pointer is on it, though the block lets go", async () => {
    const Page = page();
    const { rerender } = render(<Page pointed="b1" onAddThread={() => {}} />);
    const button = await screen.findByRole("button", { name: "Comment on this block" });
    fireEvent.pointerEnter(button);
    rerender(<Page onAddThread={() => {}} />);
    expect(add()).toBeTruthy();
    fireEvent.pointerLeave(button);
    await waitFor(() => expect(add()).toBeNull());
  });
});

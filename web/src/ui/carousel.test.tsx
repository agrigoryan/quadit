// @vitest-environment jsdom
// The carousel (ui/carousel.tsx): the arrows at the sides of a box, the
// position, going round or stopping at the ends, and the arrow keys.

import { fireEvent, render, screen } from "@testing-library/react";
import { type KeyboardEvent, useState } from "react";
import { describe, expect, it } from "vitest";
import { CarouselArrows, CarouselCount, onCarouselKey } from "@/ui/carousel";
import { TooltipProvider } from "@/ui/tooltip";

/** Three things in a box, the second shown, with the keys handled where the box is. */
function Box({ wrap, total = 3 }: { wrap: boolean; total?: number }) {
  const [index, setIndex] = useState(1);
  const steps = { index, total, wrap, onShow: setIndex };
  return (
    <TooltipProvider>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the keys reach the box from the arrows inside it */}
      <div data-testid="box" onKeyDown={(e: KeyboardEvent) => onCarouselKey(e, steps)}>
        <p>shown {index}</p>
        <CarouselArrows {...steps} size="compact" />
        <CarouselCount index={index} total={total} size="compact" />
        <video data-testid="video" />
        <input data-testid="field" />
        {/* A control that takes the arrow keys itself, as a group of choices does. */}
        <button type="button" aria-label="Choices" data-testid="choices" onKeyDown={(e) => e.preventDefault()} />
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- text that scrolls is reached with the keyboard */}
        <div data-testid="text" tabIndex={0} style={{ overflowX: "auto" }} />
      </div>
    </TooltipProvider>
  );
}

const shown = () => screen.getByText(/^shown /).textContent;
const previous = () => screen.getByRole("button", { name: "Previous" });
const next = () => screen.getByRole("button", { name: "Next" });

describe("CarouselArrows and CarouselCount", () => {
  it("show the one beside with the arrows, and say where it is", () => {
    render(<Box wrap />);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(next());
    expect(shown()).toBe("shown 2");
    expect(screen.getByText("3 / 3")).toBeTruthy();
    fireEvent.click(previous());
    fireEvent.click(previous());
    expect(shown()).toBe("shown 0");
  });

  it("go round from either end when they wrap", () => {
    render(<Box wrap />);
    fireEvent.click(next());
    fireEvent.click(next());
    expect(shown()).toBe("shown 0");
    fireEvent.click(previous());
    expect(shown()).toBe("shown 2");
    expect(next().getAttribute("aria-disabled")).toBeNull();
  });

  it("stop at the ends when they do not, marked but keeping the focus", () => {
    render(<Box wrap={false} />);
    next().focus();
    fireEvent.click(next());
    expect(shown()).toBe("shown 2");
    expect(next().getAttribute("aria-disabled")).toBe("true");
    expect(next()).toHaveProperty("disabled", false);
    fireEvent.click(next());
    expect(shown()).toBe("shown 2");
    expect(document.activeElement).toBe(next());

    fireEvent.click(previous());
    fireEvent.click(previous());
    expect(shown()).toBe("shown 0");
    expect(previous().getAttribute("aria-disabled")).toBe("true");
  });

  it("show nothing for a single one", () => {
    render(<Box wrap total={1} />);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
  });
});

describe("onCarouselKey", () => {
  it("moves with the left and right arrow keys", () => {
    render(<Box wrap />);
    fireEvent.keyDown(next(), { key: "ArrowRight" });
    expect(shown()).toBe("shown 2");
    fireEvent.keyDown(next(), { key: "ArrowRight" });
    expect(shown()).toBe("shown 0");
    fireEvent.keyDown(previous(), { key: "ArrowLeft" });
    expect(shown()).toBe("shown 2");
  });

  it("stops at the ends when the carousel does not wrap", () => {
    render(<Box wrap={false} />);
    fireEvent.keyDown(next(), { key: "ArrowLeft" });
    fireEvent.keyDown(next(), { key: "ArrowLeft" });
    expect(shown()).toBe("shown 0");
  });

  it("leaves the keys to a video, a field, and a key held with a modifier", () => {
    render(<Box wrap />);
    fireEvent.keyDown(screen.getByTestId("video"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("field"), { key: "ArrowRight" });
    fireEvent.keyDown(next(), { key: "ArrowRight", metaKey: true });
    expect(shown()).toBe("shown 1");
  });

  it("leaves the keys to a control that took them", () => {
    render(<Box wrap />);
    fireEvent.keyDown(screen.getByTestId("choices"), { key: "ArrowRight" });
    expect(shown()).toBe("shown 1");
  });

  it("leaves the keys to text that scrolls sideways, and moves from text that does not", () => {
    render(<Box wrap />);
    const text = screen.getByTestId("text");
    fireEvent.keyDown(text, { key: "ArrowRight" });
    expect(shown()).toBe("shown 2");
    Object.defineProperty(text, "scrollWidth", { value: 900 });
    Object.defineProperty(text, "clientWidth", { value: 300 });
    fireEvent.keyDown(text, { key: "ArrowRight" });
    expect(shown()).toBe("shown 2");
  });
});

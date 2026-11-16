// @vitest-environment jsdom
// The Markdown keys of a plain text box (ui/markdown-keys.ts): Cmd+B and
// Cmd+I put ** ** and _ _ around the selection or take them off, and Enter
// on a list item starts the next one, or ends the list on an empty item.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { markdownKey } from "@/ui/markdown-keys";

function Box({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return (
    <textarea
      aria-label="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => markdownKey(e)}
    />
  );
}

/** A box holding `text`, with the part between [ and ] selected, or the caret at |. */
function boxWith(text: string): HTMLTextAreaElement {
  const caret = text.indexOf("|");
  const start = caret >= 0 ? caret : text.indexOf("[");
  const end = caret >= 0 ? caret : text.indexOf("]") - 1;
  const plain = caret >= 0 ? text.replace("|", "") : text.replace("[", "").replace("]", "");
  render(<Box start={plain} />);
  const box = screen.getByLabelText<HTMLTextAreaElement>("text");
  box.focus();
  box.setSelectionRange(start, end);
  return box;
}

const press = (box: HTMLElement, key: string, code: string, more: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(box, { key, code, ...more }));
const bold = (box: HTMLElement) => press(box, "b", "KeyB", { ctrlKey: true });
const italic = (box: HTMLElement) => press(box, "i", "KeyI", { ctrlKey: true });
const enter = (box: HTMLElement) => press(box, "Enter", "Enter");
const selected = (box: HTMLTextAreaElement) => box.value.slice(box.selectionStart, box.selectionEnd);

describe("Cmd+B and Cmd+I", () => {
  it("wrap the selection, which stays selected", () => {
    const box = boxWith("make it [loud] now");
    bold(box);
    expect(box.value).toBe("make it **loud** now");
    expect(selected(box)).toBe("loud");
    italic(box);
    expect(box.value).toBe("make it **_loud_** now");
  });

  it("take the marks off a selection they are around, or that holds them", () => {
    const around = boxWith("make it **[loud]** now");
    bold(around);
    expect(around.value).toBe("make it loud now");
    expect(selected(around)).toBe("loud");
  });

  it("take the marks off a selection that holds them", () => {
    const inside = boxWith("say [_softly_] then");
    italic(inside);
    expect(inside.value).toBe("say softly then");
    expect(selected(inside)).toBe("softly");
  });

  it("put the caret between the marks when nothing is selected", () => {
    const box = boxWith("a |");
    bold(box);
    expect(box.value).toBe("a ****");
    expect(box.selectionStart).toBe(4);
  });
});

describe("Enter on a list item", () => {
  it("starts the next item of the same kind", () => {
    for (const [line, next] of [
      ["- milk", "- "],
      ["* milk", "* "],
      ["1. milk", "2. "],
      ["  9) milk", "  10) "],
      ["- [x] milk", "- [ ] "],
    ]) {
      const box = boxWith(`${line}|`);
      enter(box);
      expect(box.value).toBe(`${line}\n${next}`);
      expect(box.selectionStart).toBe(box.value.length);
      document.body.innerHTML = "";
    }
  });

  it("takes what follows the caret down into the new item", () => {
    const box = boxWith("- milk| and eggs");
    enter(box);
    expect(box.value).toBe("- milk\n-  and eggs");
  });

  it("ends the list on an empty item", () => {
    const box = boxWith("- milk\n- [ ] |");
    enter(box);
    expect(box.value).toBe("- milk\n");
    expect(box.selectionStart).toBe(box.value.length);
  });

  it("is left to the box outside a list, and with Shift", () => {
    // fireEvent answers false when the key's own action was kept from happening.
    const plain = boxWith("milk|");
    expect(fireEvent.keyDown(plain, { key: "Enter", code: "Enter" })).toBe(true);
    document.body.innerHTML = "";
    const shifted = boxWith("- milk|");
    expect(fireEvent.keyDown(shifted, { key: "Enter", code: "Enter", shiftKey: true })).toBe(true);
    expect(shifted.value).toBe("- milk");
  });
});

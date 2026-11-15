// @vitest-environment jsdom
// The keys of a flat list of rows (tasks/list-keys.ts), as the inbox and My
// work use them, with a stand-in for the panel that is open while asked to be.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { type RefObject, useMemo, useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PeekContext } from "@/lib/task-link";
import { type OpenAs, useListKeys } from "@/tasks/list-keys";

const ROWS = ["a", "b", "c"];

function List({ onOpen, onArchive }: { onOpen: (row: string, as: OpenAs) => void; onArchive: (row: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [peeked, setPeeked] = useState<string | undefined>(undefined);
  const peek = useMemo(() => ({ key: peeked, close: () => setPeeked(undefined) }), [peeked]);
  return (
    <PeekContext.Provider value={peek}>
      <Rows
        scroller={scroller}
        onOpen={(row, as) => {
          onOpen(row, as);
          if (as === "peek") setPeeked(row);
        }}
        onArchive={onArchive}
      />
      {peeked && <div data-task-panel />}
    </PeekContext.Provider>
  );
}

function Rows({
  scroller,
  onOpen,
  onArchive,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  onOpen: (row: string, as: OpenAs) => void;
  onArchive: (row: string) => void;
}) {
  const focusId = useListKeys({
    rows: ROWS,
    idOf: (row) => row,
    onOpen,
    taskKeyOf: (row) => row.toUpperCase(),
    scroller,
    keys: { e: onArchive },
  });
  return (
    <main ref={scroller} tabIndex={-1}>
      {ROWS.map((row) => (
        <div key={row} data-focused={focusId === row || undefined}>
          <a href={`#${row}`}>{row}</a>
          <button type="button">{`mark ${row}`}</button>
        </div>
      ))}
    </main>
  );
}

let step = 0;
function renderList() {
  const onOpen = vi.fn<(row: string, as: OpenAs) => void>();
  const onArchive = vi.fn<(row: string) => void>();
  step += 1;
  render(
    <MemoryRouter initialEntries={[{ pathname: "/inbox", key: `list${step}` }]}>
      <List onOpen={onOpen} onArchive={onArchive} />
    </MemoryRouter>,
  );
  return { onOpen, onArchive };
}

const press = (key: string, target: Element = document.body) => act(() => void fireEvent.keyDown(target, { key }));
const current = () => document.querySelector("[data-focused] a")?.textContent ?? null;

describe("useListKeys", () => {
  // jsdom draws nothing, so there is nothing to scroll to.
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it("moves with J and K, opens with Space and Enter, and runs the page's own keys on the current row", () => {
    const { onOpen, onArchive } = renderList();
    press("k");
    expect(current()).toBe("a");
    press("j");
    press("j");
    press("j");
    expect(current()).toBe("c");
    press("e");
    expect(onArchive).toHaveBeenCalledWith("c");
    press("Enter");
    expect(onOpen).toHaveBeenLastCalledWith("c", "page");
    press(" ");
    expect(onOpen).toHaveBeenLastCalledWith("c", "peek");
  });

  it("steps the open panel with J and K and closes it on Space, the row staying current", () => {
    const { onOpen, onArchive } = renderList();
    press("j");
    press(" ");
    press("j");
    expect(onOpen).toHaveBeenLastCalledWith("b", "peek");
    press("ArrowUp");
    expect(onOpen).toHaveBeenLastCalledWith("a", "peek");
    // The page's own keys rest while the panel covers it.
    press("e");
    expect(onArchive).not.toHaveBeenCalled();
    press(" ");
    expect(document.querySelector("[data-task-panel]")).toBeNull();
    expect(current()).toBe("a");
  });

  it("leaves Enter to a focused link and Space to a focused button", () => {
    const { onOpen } = renderList();
    press("j");
    press("Enter", screen.getByText("b"));
    press(" ", screen.getByText("mark b"));
    expect(onOpen).not.toHaveBeenCalled();
    press(" ", screen.getByText("b"));
    expect(onOpen).toHaveBeenCalledWith("a", "peek");
  });
});

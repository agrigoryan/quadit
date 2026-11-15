// @vitest-environment jsdom
// The arrows of a card lifted on the board (tasks/board.tsx boardCoordinates):
// left and right go to the column beside, even with other cards in the
// column the card leaves; the lifted card is drawn tilted, so it is a little
// wider than the cards it lies among.

import type { ClientRect, KeyboardCoordinateGetter } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { boardCoordinates } from "@/tasks/board";

type Args = Parameters<KeyboardCoordinateGetter>[1];

const rect = (left: number, top: number, width = 258, height = 64): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

// Three columns: Backlog empty, Todo with the lifted card and two more, In Progress with two.
const columns = { backlog: rect(244, 132, 290, 500), todo: rect(542, 132, 290, 500), doing: rect(840, 132, 290, 500) };
const cards: Record<string, [string, ClientRect]> = {
  t1: ["todo", rect(550, 132)],
  t2: ["todo", rect(550, 204)],
  t3: ["todo", rect(550, 276)],
  d1: ["doing", rect(848, 132)],
  d2: ["doing", rect(848, 232)],
};

function args(lifted: ClientRect, active = "t2"): Args {
  const entries = [
    ...Object.keys(columns).map((id) => ({ id, disabled: false, data: { current: undefined } })),
    ...Object.entries(cards).map(([id, [column]], index) => ({
      id,
      disabled: false,
      data: { current: { sortable: { containerId: column, index, items: [] } } },
    })),
  ];
  const rects = new Map<string, ClientRect>([
    ...Object.entries(columns),
    ...Object.entries(cards).map(([id, [, r]]): [string, ClientRect] => [id, r]),
  ]);
  return {
    active,
    currentCoordinates: { x: lifted.left, y: lifted.top },
    context: {
      active: null,
      collisionRect: lifted,
      droppableRects: rects,
      droppableContainers: { getEnabled: () => entries },
      over: null,
      scrollableAncestors: [],
    },
  } as unknown as Args; // only the fields the getter reads
}

const press = (code: string) => new KeyboardEvent("keydown", { code });
// The middle card of Todo, tilted: its box starts a little left of the column's cards.
const lifted = rect(549.2, 200.5, 273.6, 72.6);

describe("boardCoordinates", () => {
  it("goes right to the column beside, to the card nearest the same height", () => {
    expect(boardCoordinates(press("ArrowRight"), args(lifted))).toEqual({ x: 848, y: 232 });
  });

  it("goes left to an empty column at its top", () => {
    expect(boardCoordinates(press("ArrowLeft"), args(lifted))).toEqual({ x: 244, y: 132 });
  });

  it("stays put at the last column", () => {
    expect(boardCoordinates(press("ArrowRight"), args(rect(847.2, 132, 273.6, 72.6), "d1"))).toBeUndefined();
  });
});

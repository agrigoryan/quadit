// @vitest-environment jsdom
// The arrows of a card lifted on the board (tasks/board.tsx boardCoordinates):
// left and right go to the column beside, even with other cards in the
// column the card leaves; the lifted card is drawn tilted, so it is a little
// wider than the cards it lies among. And what a dragged card is over
// (boardCollision): the column comes from the pointer, the card from within it.

import type { ClientRect, KeyboardCoordinateGetter } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { boardCollision, boardCoordinates } from "@/tasks/board";

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

type CollisionArgs = Parameters<typeof boardCollision>[0];

/** What dnd-kit hands the collision detection: the droppables in place, the dragged card's box, the pointer. */
function collisionArgs(place: Record<string, [string, ClientRect]>, lifted: ClientRect, pointer: Point | null) {
  const entries = [
    ...Object.keys(columns).map((id) => ({ id, disabled: false, data: { current: undefined } })),
    ...Object.entries(place).map(([id, [column]], index) => ({
      id,
      disabled: false,
      data: { current: { sortable: { containerId: column, index, items: [] } } },
    })),
  ];
  const rects = new Map<string, ClientRect>([
    ...Object.entries(columns),
    ...Object.entries(place).map(([id, [, r]]): [string, ClientRect] => [id, r]),
  ]);
  return {
    active: { id: "t2" },
    collisionRect: lifted,
    droppableRects: rects,
    droppableContainers: entries,
    pointerCoordinates: pointer,
  } as unknown as CollisionArgs; // only the fields the detection reads
}

type Point = { x: number; y: number };
const overOf = (args: CollisionArgs) => boardCollision(args)[0]?.id;

describe("boardCollision", () => {
  it("is over the column under the pointer, though the card's own place is nearer", () => {
    // Todo's middle card, dragged by its middle into empty Backlog: its box is still closer to where it was.
    const box = rect(400, 204, 273.6, 72.6);
    expect(overOf(collisionArgs(cards, box, { x: 520, y: 240 }))).toBe("backlog");
  });

  it("is over the card of the pointer's column nearest the dragged one", () => {
    expect(overOf(collisionArgs(cards, rect(780, 225, 273.6, 72.6), { x: 900, y: 260 }))).toBe("d2");
  });

  // Halfway between Todo and In Progress the dragged card (t2, tall) is as near Todo's cards as In
  // Progress's. Put in In Progress, it pushes d1 down, and t3 takes its place in Todo: by the
  // corners alone t3 is then the nearest, the card went back to Todo, and forth, for ever.
  it("gives the same column once the card is put in the column it is over", () => {
    const box = rect(699, 204);
    const pointer = { x: 849, y: 236 };
    const before: Record<string, [string, ClientRect]> = {
      t2: ["todo", rect(550, 204, 258, 100)],
      t3: ["todo", rect(550, 310)],
      d1: ["doing", rect(848, 204)],
    };
    expect(overOf(collisionArgs(before, box, pointer))).toBe("d1");
    const after: Record<string, [string, ClientRect]> = {
      t3: ["todo", rect(550, 204)],
      t2: ["doing", rect(848, 204, 258, 100)],
      d1: ["doing", rect(848, 310)],
    };
    expect(overOf(collisionArgs(after, box, pointer))).toBe("t2");
  });

  it("takes the nearer column when the pointer is in the gap between two", () => {
    expect(overOf(collisionArgs(cards, rect(700, 132, 273.6, 72.6), { x: 838, y: 160 }))).toBe("d1");
    expect(overOf(collisionArgs(cards, rect(700, 132, 273.6, 72.6), { x: 834, y: 160 }))).toBe("t1");
  });

  it("is over nothing beyond the last column or above the board", () => {
    expect(boardCollision(collisionArgs(cards, rect(1100, 132, 273.6, 72.6), { x: 1200, y: 160 }))).toEqual([]);
    expect(boardCollision(collisionArgs(cards, rect(550, 40, 273.6, 72.6), { x: 600, y: 60 }))).toEqual([]);
  });

  it("from the keyboard, with no pointer, goes by the middle of the lifted card", () => {
    expect(overOf(collisionArgs(cards, rect(244, 132, 273.6, 72.6), null))).toBe("backlog");
  });
});

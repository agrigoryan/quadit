// @vitest-environment jsdom
// The compare view (decisions/compare-view.tsx) on a desktop, opened from a
// question on the task page: from an option's picture it shows that option
// alone, and its arrows and the arrow keys go to the ones beside it; from
// "Compare" it shows them side by side; its header switches between the two.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearStore, getState, loadBootstrap } from "@/data/store";
import type { Attachment, Decision, FileRow, Member, Task, User, Workspace } from "@/types/core";
import { DecisionBlock } from "@/decisions/decision-block";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

const task = { id: "t1", project_id: "p1", key: "SVA-1", title: "Pick a logo", number: 1, rank: "a" } as Task;
const labels = ["Round", "Square", "Star"];

const decision = {
  id: "d1",
  task_id: "t1",
  kind: "choice",
  question: "Which logo?",
  state: "open",
  created_by: "agent",
  asked_id: "u1",
  rank: "a",
  options: labels.map((label, i) => ({ id: `o${i}`, label })),
} as Decision;

function picture(id: string): FileRow {
  return {
    id,
    name: `${id}.png`,
    content_type: "image/png",
    size: 1,
    state: "ready",
    uploaded_by: "agent",
    created_at: 0,
    url: `/files/${id}.png`,
  };
}

/** One picture on each option, and a second one on "Square". */
const attachments: Attachment[] = [
  ...labels.map((_, i) => ({
    id: `a${i}`,
    file_id: `f${i}`,
    file: picture(`f${i}`),
    subject_type: "decision_option" as const,
    subject_id: `o${i}`,
    rank: `a${i}`,
    created_by: "agent",
    created_at: 0,
  })),
  {
    id: "a9",
    file_id: "f9",
    file: picture("f9"),
    subject_type: "decision_option",
    subject_id: "o1",
    rank: "b",
    created_by: "agent",
    created_at: 0,
  },
];

function show() {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", handle: "ann", name: "Ann", role: "owner", kind: "person" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    projects: [{ id: "p1", key: "SVA", name: "Live", rank: "a" }],
    members: [{ user_id: "agent", handle: "coder", name: "Coder", kind: "agent" }],
    tasks: [task],
    decisions: [decision],
    attachments,
  });
  const stored = getState().collections.decisions.d1 as Decision;
  render(
    <MemoryRouter>
      <TooltipProvider>
        <DecisionBlock decision={stored} />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
}

const card = (label: string) => screen.getByRole("article", { name: label });
const view = () => screen.getByRole("dialog", { name: "Which logo?" });
/** The options on stage, by name. */
const onStage = () =>
  within(view())
    .getAllByRole("region")
    .map((pane) => pane.getAttribute("aria-label"));
const shownFile = () => within(view()).getByRole("region").querySelector("img")?.getAttribute("src");
const press = (key: string) => act(() => void fireEvent.keyDown(view(), { key }));
const viewButton = (name: string) => within(view()).getByRole("button", { name });

beforeAll(() => {
  // A desktop wide enough for four panes; jsdom has no layout of its own.
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList; // jsdom has none: a stand-in with what useMedia calls
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(show);

describe("an option's picture", () => {
  it("carries a button that opens it, alone, on the file shown", () => {
    const square = card("Square");
    fireEvent.click(within(square).getByRole("button", { name: "Next file" }));
    fireEvent.click(within(square).getByRole("button", { name: "Open Square full screen" }));
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f9.png");
    expect(within(view()).getByText("Option 2 of 3 · picture 2 of 2")).toBeTruthy();
    expect(viewButton("One at a time").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the same way when the picture itself is clicked", () => {
    const img = card("Star").querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.click(img as HTMLImageElement);
    expect(onStage()).toEqual(["Star"]);
    expect(within(view()).getByText("Option 3 of 3")).toBeTruthy();
  });
});

describe("an option's several pictures on its card", () => {
  const cardFile = (label: string) => card(label).querySelector("img")?.getAttribute("src");

  it("go round with the arrows at their sides, and say where they are", () => {
    const square = card("Square");
    expect(within(square).getByText("1 / 2")).toBeTruthy();
    fireEvent.click(within(square).getByRole("button", { name: "Next file" }));
    expect(cardFile("Square")).toBe("/files/f9.png");
    expect(within(square).getByText("2 / 2")).toBeTruthy();
    fireEvent.click(within(square).getByRole("button", { name: "Next file" }));
    expect(cardFile("Square")).toBe("/files/f1.png");
    fireEvent.click(within(square).getByRole("button", { name: "Previous file" }));
    expect(cardFile("Square")).toBe("/files/f9.png");
  });

  it("move with the arrow keys from the card's buttons", () => {
    const open = within(card("Square")).getByRole("button", { name: "Open Square full screen" });
    fireEvent.keyDown(open, { key: "ArrowRight" });
    expect(cardFile("Square")).toBe("/files/f9.png");
  });

  it("have no arrows on an option with one picture", () => {
    expect(within(card("Round")).queryByRole("button", { name: "Next file" })).toBeNull();
    expect(within(card("Round")).queryByText("1 / 1")).toBeNull();
  });
});

describe("one at a time", () => {
  it("walks through every picture with the arrows at its sides, option after option, and stops at the ends", () => {
    fireEvent.click(within(card("Square")).getByRole("button", { name: "Open Square full screen" }));
    const next = viewButton("Next");
    const previous = viewButton("Previous");
    expect(within(view()).getByText("Option 2 of 3 · picture 1 of 2")).toBeTruthy();

    fireEvent.click(next);
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f9.png");
    expect(within(view()).getByText("Option 2 of 3 · picture 2 of 2")).toBeTruthy();

    // From an option's last picture to the next option's first.
    fireEvent.click(next);
    expect(onStage()).toEqual(["Star"]);
    expect(within(view()).getByText("Option 3 of 3")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(next);
    expect(onStage()).toEqual(["Star"]);

    // Back, the option before comes in on its last picture.
    fireEvent.click(previous);
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f9.png");
    fireEvent.click(previous);
    expect(shownFile()).toBe("/files/f1.png");
    fireEvent.click(previous);
    expect(onStage()).toEqual(["Round"]);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(onStage()).toEqual(["Round"]);
  });

  it("walks the same way with the left and right arrow keys, and steps within an option with up and down", () => {
    fireEvent.click(within(card("Round")).getByRole("button", { name: "Open Round full screen" }));
    press("ArrowRight");
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f1.png");
    press("ArrowRight");
    expect(shownFile()).toBe("/files/f9.png");
    press("ArrowRight");
    expect(onStage()).toEqual(["Star"]);
    press("ArrowLeft");
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f9.png");

    press("ArrowDown");
    expect(onStage()).toEqual(["Square"]);
    expect(shownFile()).toBe("/files/f1.png");
    press("ArrowUp");
    expect(shownFile()).toBe("/files/f9.png");
  });

  it("keeps an option's answer button", () => {
    fireEvent.click(within(card("Round")).getByRole("button", { name: "Open Round full screen" }));
    expect(within(within(view()).getByRole("region")).getByRole("button", { name: "This one" })).toBeTruthy();
  });
});

describe("side by side", () => {
  it("has a carousel in each pane for that option's pictures", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    const square = within(view()).getByRole("region", { name: "Square" });
    expect(within(square).getByText("1 / 2")).toBeTruthy();
    fireEvent.click(within(square).getByRole("button", { name: "Next file" }));
    expect(square.querySelector("img")?.getAttribute("src")).toBe("/files/f9.png");
    fireEvent.click(within(square).getByRole("button", { name: "Next file" }));
    expect(square.querySelector("img")?.getAttribute("src")).toBe("/files/f1.png");
    expect(
      within(within(view()).getByRole("region", { name: "Round" })).queryByRole("button", { name: "Next file" }),
    ).toBeNull();
  });

  it("moves between options with the left and right arrow keys", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    press("ArrowRight");
    expect(within(view()).getByRole("region", { name: "Square" }).getAttribute("aria-current")).toBe("true");
  });
});

describe("Compare", () => {
  it("opens the options side by side", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    expect(onStage()).toEqual(labels);
    expect(viewButton("Side by side").getAttribute("aria-pressed")).toBe("true");
    expect(within(view()).queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("the layout switch", () => {
  it("shows the focused option alone, and all of them again", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    press("ArrowRight");
    fireEvent.click(viewButton("One at a time"));
    expect(onStage()).toEqual(["Square"]);
    fireEvent.click(viewButton("Side by side"));
    expect(onStage()).toEqual(labels);
  });

  it("switches with the L key", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    press("l");
    expect(onStage()).toEqual(["Round"]);
    press("l");
    expect(onStage()).toEqual(labels);
  });
});

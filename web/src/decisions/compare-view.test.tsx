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
    expect(within(view()).getByText("2 of 3")).toBeTruthy();
    expect(viewButton("One at a time").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the same way when the picture itself is clicked", () => {
    const img = card("Star").querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.click(img as HTMLImageElement);
    expect(onStage()).toEqual(["Star"]);
  });
});

describe("one at a time", () => {
  it("goes to the next and the previous option with the arrows at its sides, and stops at the ends", () => {
    fireEvent.click(within(card("Square")).getByRole("button", { name: "Open Square full screen" }));
    const next = viewButton("Next option");
    const previous = viewButton("Previous option");

    fireEvent.click(next);
    expect(onStage()).toEqual(["Star"]);
    expect(within(view()).getByText("3 of 3")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(onStage()).toEqual(["Round"]);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(onStage()).toEqual(["Round"]);
  });

  it("goes to the next and the previous option with the arrow keys", () => {
    fireEvent.click(within(card("Round")).getByRole("button", { name: "Open Round full screen" }));
    press("ArrowRight");
    expect(onStage()).toEqual(["Square"]);
    press("ArrowDown");
    expect(shownFile()).toBe("/files/f9.png");
    press("ArrowRight");
    expect(onStage()).toEqual(["Star"]);
    press("ArrowLeft");
    expect(onStage()).toEqual(["Square"]);
  });

  it("keeps an option's answer button", () => {
    fireEvent.click(within(card("Round")).getByRole("button", { name: "Open Round full screen" }));
    expect(within(within(view()).getByRole("region")).getByRole("button", { name: "This one" })).toBeTruthy();
  });
});

describe("Compare", () => {
  it("opens the options side by side", () => {
    fireEvent.click(screen.getByRole("button", { name: "Compare side by side" }));
    expect(onStage()).toEqual(labels);
    expect(viewButton("Side by side").getAttribute("aria-pressed")).toBe("true");
    expect(within(view()).queryByRole("button", { name: "Next option" })).toBeNull();
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

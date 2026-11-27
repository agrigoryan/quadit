// @vitest-environment jsdom
// The date picker (ui/date-picker.tsx, ui/month-grid.tsx): words typed are
// read as a day, shown and taken with Enter; days by name and the month's
// days pick theirs; Clear empties; days out of reach are refused; and no
// time zone moves a day, however far it is from UTC. Today is Thursday
// 26 November 2026 at noon, in American English, whose week starts on Sunday.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateField, DatePanel, type DatePanelProps } from "@/ui/date-picker";
import { TooltipProvider } from "@/ui/tooltip";

// The language is fixed before lib/time.ts builds its formats and lib/week.ts reads the week.
const before = vi.hoisted(() => {
  const was = { zone: process.env.TZ, format: Intl.DateTimeFormat };
  // Called with new or without: date-fns, under the grid, calls it without.
  const english = (locales?: string | string[], options?: Intl.DateTimeFormatOptions) =>
    new was.format(locales ?? "en-US", options);
  Intl.DateTimeFormat = new Proxy(was.format, {
    construct: (_, [locales, options]) => english(locales, options),
    apply: (_, __, [locales, options]) => english(locales, options),
  });
  return was;
});

afterAll(() => {
  process.env.TZ = before.zone;
  Intl.DateTimeFormat = before.format;
});

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 10, 26, 12), toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function panel(props: Partial<DatePanelProps> = {}) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <DatePanel label="Due date" value={undefined} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return onChange;
}

const box = () => screen.getByRole("textbox", { name: "Due date" });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const enter = () => fireEvent.keyDown(box(), { key: "Enter" });
const day = (name: string) => screen.getByRole("button", { name });
const cellOf = (button: HTMLElement) => button.closest('[role="gridcell"]');

describe("DatePanel", () => {
  it("opens with the caret in a labelled box, over a grid named by its month whose days have their full names", () => {
    panel();
    expect(box()).toHaveFocus();
    const grid = screen.getByRole("grid", { name: "November 2026" });
    expect(within(grid).getByRole("button", { name: "Today, Thursday, November 26, 2026" })).toBeInTheDocument();
    expect(within(grid).getByRole("button", { name: "Friday, November 27, 2026" })).toBeInTheDocument();
    // Weeks start on Sunday in American English.
    expect(grid.querySelector("th")).toHaveTextContent("Sun");
  });

  it("reads what is typed, says the day under the box, shows it picked in the grid, and takes it with Enter", () => {
    const onChange = panel();
    type("next fri");
    expect(box()).toHaveAccessibleDescription("Fri, Dec 4");
    expect(screen.getByRole("grid", { name: "December 2026" })).toBeInTheDocument();
    expect(cellOf(day("Friday, December 4, 2026, selected"))).toHaveAttribute("aria-selected", "true");
    enter();
    expect(onChange).toHaveBeenCalledWith("2026-12-04");
  });

  it("says, quietly, what it cannot read, and Enter takes nothing", () => {
    const onChange = panel({ value: "2026-12-01" });
    type("soonish");
    expect(box()).toHaveAccessibleDescription("Can’t read “soonish” as a date");
    expect(box()).toHaveAttribute("aria-invalid", "true");
    enter();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the day set while nothing is typed", () => {
    panel({ value: "2026-12-01" });
    expect(box()).toHaveAccessibleDescription("Tue, Dec 1");
    expect(screen.getByRole("grid", { name: "December 2026" })).toBeInTheDocument();
    expect(cellOf(day("Tuesday, December 1, 2026, selected"))).toHaveAttribute("aria-selected", "true");
  });

  it("picks a day of the month by a click, and moves between months", () => {
    const onChange = panel();
    fireEvent.click(day("Friday, November 27, 2026"));
    expect(onChange).toHaveBeenLastCalledWith("2026-11-27");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("grid", { name: "December 2026" })).toBeInTheDocument();
    fireEvent.click(day("Thursday, December 31, 2026"));
    expect(onChange).toHaveBeenLastCalledWith("2026-12-31");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeInTheDocument();
  });

  it("moves through the grid with the keyboard and picks with Enter", () => {
    const onChange = panel({ value: "2026-11-30" });
    const start = day("Monday, November 30, 2026, selected");
    // The day picked is the grid's one Tab stop.
    expect(start).toHaveAttribute("tabindex", "0");
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(day("Tuesday, December 1, 2026")).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? start, { key: "PageDown" });
    expect(day("Friday, January 1, 2027")).toHaveFocus();
    fireEvent.click(document.activeElement ?? start);
    expect(onChange).toHaveBeenCalledWith("2027-01-01");
  });

  it("offers days by name with their dates, one Tab stop moved through with the arrows", () => {
    const onChange = panel({
      quick: () => [
        { label: "Tomorrow", day: "2026-11-27" },
        { label: "Next week", day: "2026-11-30" },
      ],
    });
    const group = screen.getByRole("toolbar", { name: "Suggested days" });
    const [tomorrow, next] = within(group).getAllByRole("button");
    expect(tomorrow).toHaveTextContent("TomorrowFri, Nov 27");
    expect(tomorrow).toHaveAttribute("tabindex", "0");
    expect(next).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(tomorrow).toHaveFocus();
    fireEvent.keyDown(tomorrow as HTMLElement, { key: "ArrowDown" });
    expect(next).toHaveFocus();
    fireEvent.click(next as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("2026-11-30");
  });

  it("clears where the value may be empty, and only there", () => {
    const onChange = panel({ value: "2026-12-01", clearable: true });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("has no Clear for a day that must be set", () => {
    panel({ value: "2026-12-01" });
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("keeps a day of a year below 100 as it is", () => {
    const onChange = panel({ value: "0099-03-15" });
    const picked = screen.getByRole("button", { name: /, selected$/ });
    expect(cellOf(picked)).toHaveAttribute("data-day", "0099-03-15");
    fireEvent.click(picked);
    expect(onChange).toHaveBeenCalledWith("0099-03-15");
  });

  it("refuses a day before the first it may be, typed or clicked, and tints the range", () => {
    const onChange = panel({ min: "2026-11-20", stretch: { from: "2026-11-20", to: "2026-11-24" } });
    expect(day("Thursday, November 19, 2026")).toBeDisabled();
    fireEvent.click(day("Thursday, November 19, 2026"));
    type("nov 19 2026");
    expect(box()).toHaveAccessibleDescription("Not before Nov 20");
    enter();
    expect(onChange).not.toHaveBeenCalled();
    expect(cellOf(day("Sunday, November 22, 2026"))).toHaveClass("bg-accent-soft");
    expect(cellOf(day("Friday, November 27, 2026"))).not.toHaveClass("bg-accent-soft");
  });
});

describe("DateField", () => {
  it("shows the day as the app writes days, and opens the picker; a pick closes it", () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <DateField label="Target date" value="2026-12-04" onChange={onChange} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Target date: Dec 4" }));
    const dialog = screen.getByRole("dialog", { name: "Target date" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Target date" }), { target: { value: "+1" } });
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Target date" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-11-27");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when no day is set", () => {
    render(<DateField label="Start date" value={undefined} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Start date: No date" })).toBeInTheDocument();
  });
});

// Far east and far west of UTC a day still goes in and comes out as itself.
describe.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])("in %s", (zone) => {
  beforeAll(() => void (process.env.TZ = zone));

  it("is in a zone far from UTC", () => {
    const hours = -new Date(2026, 10, 26, 12).getTimezoneOffset() / 60;
    expect(Math.abs(hours)).toBeGreaterThanOrEqual(11);
  });

  it("marks today and the day set on their own days, and gives back the day clicked", () => {
    const onChange = panel({ value: "2026-12-05" });
    expect(cellOf(day("Saturday, December 5, 2026, selected"))).toHaveAttribute("data-day", "2026-12-05");
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(cellOf(day("Today, Thursday, November 26, 2026"))).toHaveAttribute("data-day", "2026-11-26");
    fireEvent.click(day("Sunday, November 1, 2026"));
    expect(onChange).toHaveBeenCalledWith("2026-11-01");
  });

  it("reads typed words from the zone's own today", () => {
    const onChange = panel();
    type("tomorrow");
    enter();
    expect(onChange).toHaveBeenCalledWith("2026-11-27");
  });
});

// A month of days to pick one from, with its name, a way to the months
// before and after and back to today: react-day-picker, dressed as the rest
// of the app through its class names (none of its own style sheet is used).
// The library counts in Date objects; here it counts in UTC, as lib/days.ts
// does, and a day goes in and out as its UTC midnight, so no time zone can
// move a day. The library gives the grid its keyboard: the arrows move by a
// day or a week, Page Up and Page Down by a month, Home and End to the ends
// of the week, Enter picks.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayButton, type DayButtonProps, DayPicker } from "react-day-picker";
import { cx } from "@/lib/cx";
import { addMonths, dayOfMonth, monthStart, sameMonth, utcDayOf, utcMidnight } from "@/lib/days";
import { t } from "@/lib/i18n";
import { fullDay, monthAndYear, weekdayName } from "@/lib/time";
import type { Week } from "@/lib/week";
import { Button, IconButton } from "@/ui/button";

export interface MonthGridProps {
  /** The month shown, as any day of it. */
  month: string;
  onMonthChange: (month: string) => void;
  /** The day shown as picked. */
  picked: string | undefined;
  onPick: (day: string) => void;
  today: string;
  week: Week;
  /** A run of days tinted lightly behind the others: the current cycle, or the range a day is one end of. */
  stretch?: { from: string; to: string };
  /** The first and the last day that can be picked; the days beyond are shown faintly. */
  min?: string;
  max?: string;
}

/** A day as the library takes it: the moment it begins in UTC. */
const dateOf = (day: string) => new Date(utcMidnight(day));
/** And back: the library's dates are UTC midnights (or other moments of the same UTC day). */
const dayOf = (date: Date) => utcDayOf(date.getTime());

/** The library's own week counts from Sunday; lib/week.ts from Monday. */
const fromSunday = (day: number) => (day + 1) % 7;

/** One day of the grid, drawn by what it is: picked, today, in another month, a weekend, out of reach. */
function Day({ modifiers: is, className, ...rest }: DayButtonProps) {
  return (
    <DayButton
      {...rest}
      modifiers={is}
      className={cx(
        className,
        is.selected
          ? "bg-accent font-medium text-accent-ink hover:bg-accent-hover"
          : cx(
              "hover:bg-hover",
              is.outside ? "text-ink-3/70" : is.weekend ? "text-ink-2" : "text-ink",
              // Today is a ring, so the day picked is the only one filled.
              is.today && "font-semibold text-accent-text shadow-[inset_0_0_0_1.5px_var(--accent)]",
            ),
        is.disabled && "opacity-35",
      )}
    />
  );
}

/** The month's name above its weeks, with Today and the months either side; then the grid of days. */
export function MonthGrid({ month, onMonthChange, picked, onPick, today, week, stretch, min, max }: MonthGridProps) {
  const shown = monthStart(month);
  const disabled = [...(min ? [{ before: dateOf(min) }] : []), ...(max ? [{ after: dateOf(max) }] : [])];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 pl-2">
        {/* The grid's own caption, kept for screen readers, says the month as it changes. */}
        <h3 aria-hidden className="min-w-0 flex-1 truncate text-sm font-medium">
          {monthAndYear(shown)}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={sameMonth(shown, today)}
          onClick={() => onMonthChange(today)}
          className="max-md:h-8"
        >
          {t("date.today")}
        </Button>
        <IconButton size="sm" label={t("date.previousMonth")} onClick={() => onMonthChange(addMonths(shown, -1))}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <IconButton size="sm" label={t("date.nextMonth")} onClick={() => onMonthChange(addMonths(shown, 1))}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
      <DayPicker
        mode="single"
        required
        timeZone="UTC"
        month={dateOf(shown)}
        onMonthChange={(date) => onMonthChange(dayOf(date))}
        today={dateOf(today)}
        selected={picked ? dateOf(picked) : undefined}
        onSelect={(_, day) => onPick(dayOf(day))}
        weekStartsOn={fromSunday(week.first) as 0 | 1 | 2 | 3 | 4 | 5 | 6}
        disabled={disabled}
        modifiers={{
          weekend: { dayOfWeek: week.weekend.map(fromSunday) },
          stretch: stretch && { from: dateOf(stretch.from), to: dateOf(stretch.to) },
          stretchStart: stretch && dateOf(stretch.from),
          stretchEnd: stretch && dateOf(stretch.to),
        }}
        modifiersClassNames={{
          stretch: "bg-accent-soft",
          stretchStart: "rounded-l-full",
          stretchEnd: "rounded-r-full",
        }}
        showOutsideDays
        fixedWeeks
        hideNavigation
        components={{ DayButton: Day }}
        formatters={{
          formatCaption: (date) => monthAndYear(dayOf(date)),
          formatWeekdayName: (date) => weekdayName(dayOf(date)),
          formatDay: (date) => String(dayOfMonth(dayOf(date))),
        }}
        labels={{
          labelGrid: (date) => monthAndYear(dayOf(date)),
          labelWeekday: (date) => weekdayName(dayOf(date), "long"),
          labelDayButton: (date, is) => {
            const name = fullDay(dayOf(date));
            const said = is.today ? t("date.dayToday", { day: name }) : name;
            return is.selected ? t("date.daySelected", { day: said }) : said;
          },
        }}
        classNames={{
          root: "w-fit",
          months: "",
          month: "",
          month_caption: "sr-only",
          month_grid: "border-collapse",
          weekdays: "",
          weekday: "h-7 p-0 text-2xs font-medium text-ink-3",
          weeks: "",
          week: "",
          day: "p-0 text-center",
          day_button:
            "flex size-8 items-center justify-center rounded-full text-sm tnum transition-colors duration-100 " +
            "outline-offset-0 disabled:pointer-events-none max-md:size-9",
          // The day's own button draws what it is; its cell only carries the tint behind it.
          today: "",
          selected: "",
          outside: "",
          disabled: "",
          focused: "",
          hidden: "invisible",
        }}
      />
    </div>
  );
}

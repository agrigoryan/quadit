// The one way a day is picked anywhere in the app: a box that reads typed
// words ("tomorrow", "next fri", "dec 5"; lib/day-words.ts), a few days
// offered by name, a month to pick from (ui/month-grid.tsx) and Clear. It
// comes as the panel itself, for a popover something else opens (a task
// property's); in a popover under any trigger; and as a field for forms.
// Days are YYYY-MM-DD strings, as they are stored.

import { type KeyboardEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useNow } from "@/data/live";
import { cx } from "@/lib/cx";
import { readDay } from "@/lib/day-words";
import { t } from "@/lib/i18n";
import { formatDay, localDay, weekdayAndDay } from "@/lib/time";
import { personWeek } from "@/lib/week";
import { Button, type ButtonProps } from "@/ui/button";
import { MonthGrid, type MonthGridProps } from "@/ui/month-grid";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** A day offered by name: "Tomorrow", "End of this cycle". */
export interface QuickDay {
  label: string;
  day: string;
}

export interface DatePanelProps extends Pick<MonthGridProps, "stretch" | "min" | "max"> {
  /** What the day is: "Due date". It names the box and the panel. */
  label: string;
  /** The day set now, if any; none where several things are set to different days. */
  value: string | undefined;
  /** Something has a day to clear though `value` names none: several things set to different days. */
  someSet?: boolean;
  /** A day picked, typed or chosen by name; null for Clear. */
  onChange: (day: string | null) => void;
  /** The value may be empty: the panel offers Clear. */
  clearable?: boolean;
  /**
   * Days offered by name, in their order, beside the month: worked out from
   * the panel's own today, so they count from the day the typed words do.
   */
  quick?: (today: string) => QuickDay[];
  /**
   * Hears the day the box reads as it is typed, while it is one that can be
   * picked (undefined otherwise): for a caller that keeps it when the person
   * leaves without Enter, as a table's cell does.
   */
  onTyped?: (day: string | undefined) => void;
}

/** The arrows move between the days offered by name, which are one Tab stop. */
function moveAmong(e: KeyboardEvent<HTMLDivElement>) {
  const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = buttons.findIndex((button) => button === e.target);
  if (at < 0) return;
  const to = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : at + (step[e.key] ?? Number.NaN);
  const next = buttons[to];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/**
 * The box, the days by name, the month and Clear, for use inside a popover.
 * The box has the focus; what is typed is read as a day as it is typed,
 * shown under it and in the month, and Enter takes it.
 */
export function DatePanel({
  label,
  value,
  someSet,
  onChange,
  clearable,
  quick,
  stretch,
  min,
  max,
  onTyped,
}: DatePanelProps) {
  const today = localDay(useNow());
  const reading = { today, week: personWeek };
  const [text, setText] = useState("");
  // An empty day opens on today's month, or on the nearest month with days that can be picked.
  const [month, setMonth] = useState(() => value ?? (min && today < min ? min : max && today > max ? max : today));
  const panel = useRef<HTMLDivElement>(null);
  const lineId = useId();

  const picks = quick?.(today) ?? [];
  const typed = text.trim();
  const read = typed ? readDay(typed, reading) : undefined;
  const refusal = !typed
    ? undefined
    : !read
      ? t("date.cannotRead", { text: typed })
      : min && read < min
        ? t("date.tooEarly", { day: formatDay(min) })
        : max && read > max
          ? t("date.tooLate", { day: formatDay(max) })
          : undefined;
  const reachable = (day: string) => (!min || day >= min) && (!max || day <= max);
  const line = refusal ?? (read ? weekdayAndDay(read) : value ? weekdayAndDay(value) : "");

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      // The panel is drawn apart from the page, but React hands its events up the tree it was made in:
      // in a dialog's form, Enter would reach the dialog and send it.
      e.preventDefault();
      e.stopPropagation();
      if (read && !refusal) onChange(read);
    } else if (e.key === "ArrowDown") {
      // On to the days by name, or the month's day that takes the focus.
      const next = panel.current?.querySelector<HTMLButtonElement>(
        '[data-quick] button[tabindex="0"], [role="grid"] button[tabindex="0"]',
      );
      if (!next) return;
      e.preventDefault();
      next.focus();
    }
  }

  return (
    <div ref={panel} className="flex w-max max-w-[calc(100vw-1rem)] flex-col max-sm:w-[calc(100vw-1rem)]">
      <div className="border-b border-line">
        <input
          autoFocus
          aria-label={label}
          aria-describedby={lineId}
          aria-invalid={refusal ? true : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const day = readDay(e.target.value, reading);
            if (day) setMonth(day);
            onTyped?.(day && reachable(day) ? day : undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("date.typeHint")}
          className="h-9 w-full bg-transparent px-3 text-sm outline-none"
        />
        <p
          id={lineId}
          aria-live="polite"
          className={cx(
            // On a phone an empty line gives its room to the month.
            "h-6 truncate px-3 text-xs leading-4 tnum max-sm:empty:hidden",
            read && !refusal ? "text-ink-2" : "text-ink-3",
          )}
        >
          {line}
        </p>
      </div>

      <div className="flex max-sm:flex-col">
        {picks.length > 0 && (
          // A toolbar: one Tab stop, on its first button; the arrows move among them. On a phone it is
          // one row above the month, scrolled sideways, so the whole picker fits the screen.
          <div
            data-quick
            role="toolbar"
            tabIndex={-1}
            aria-orientation="vertical"
            aria-label={t("date.quick")}
            onKeyDown={moveAmong}
            className="flex w-52 flex-col gap-px border-r border-line p-1 no-scrollbar max-sm:w-auto max-sm:flex-row max-sm:gap-1 max-sm:overflow-x-auto max-sm:border-r-0 max-sm:border-b max-sm:p-2"
          >
            {picks.map((pick, i) => (
              <button
                key={pick.label}
                type="button"
                tabIndex={i === 0 ? 0 : -1}
                disabled={!reachable(pick.day)}
                onClick={() => onChange(pick.day)}
                className={cx(
                  "flex min-h-7 items-center gap-2 rounded-sm px-2 py-1 text-left text-sm select-none max-md:min-h-9",
                  "max-sm:shrink-0 max-sm:flex-col max-sm:items-start max-sm:gap-0 max-sm:rounded-md max-sm:border max-sm:border-line",
                  "hover:bg-hover focus-visible:bg-hover disabled:opacity-40",
                  pick.day === value && "text-accent-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate max-sm:flex-none">{pick.label}</span>
                <span className="shrink-0 text-xs text-ink-3 tnum">{weekdayAndDay(pick.day)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="p-2 max-sm:w-full">
          <MonthGrid
            month={month}
            onMonthChange={setMonth}
            picked={read && !refusal ? read : value}
            onPick={onChange}
            today={today}
            week={personWeek}
            stretch={stretch}
            min={min}
            max={max}
          />
        </div>
      </div>

      {clearable && (
        <div className="flex border-t border-line p-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!value && !someSet}
            onClick={() => onChange(null)}
            className="max-md:h-8"
          >
            {t("date.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}

export interface DatePickerProps extends DatePanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the picker. Leave out when using `anchor`. */
  children?: ReactNode;
  /** Open next to this element instead of a trigger (for keyboard shortcuts). */
  anchor?: RefObject<Element | null>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

/** The panel in a popover, under its trigger or beside an anchor. A day picked closes it. */
export function DatePicker({ open, onOpenChange, children, anchor, align, side, onChange, ...panel }: DatePickerProps) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      <PopoverContent align={align} side={side} aria-label={panel.label} className="p-0">
        <DatePanel
          {...panel}
          onChange={(day) => {
            onChange(day);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateFieldProps extends Omit<DatePickerProps, "children" | "anchor" | "open" | "onOpenChange"> {
  id?: string;
  /** Shown while no day is set. */
  placeholder?: string;
  disabled?: boolean;
  size?: ButtonProps["size"];
  className?: string;
}

/** A form's day: a button that shows it as the app writes days and opens the picker. */
export function DateField({ id, placeholder, disabled, size, className, ...picker }: DateFieldProps) {
  const shown = picker.value ? formatDay(picker.value) : (placeholder ?? t("date.none"));
  return (
    <DatePicker {...picker}>
      <Button
        id={id}
        size={size}
        disabled={disabled}
        aria-label={`${picker.label}: ${shown}`}
        className={cx("justify-start gap-2 tnum", className)}
      >
        <CalendarDays className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className={cx("truncate", !picker.value && "font-normal text-ink-3")}>{shown}</span>
      </Button>
    </DatePicker>
  );
}

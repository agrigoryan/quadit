// The rows of the timeline. Each row is a name cell that stays at the left
// while the scale scrolls, and a track the bars sit on. An epic row opens
// to show its tasks underneath.

import "@/insights/viz.css";
import { ChevronRight, Plus } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { daysUntil, formatDay } from "@/lib/time";
import type { Category, Epic } from "@/lib/types";
import { dayOf } from "@/insights/lib/format";
import { Bar } from "@/insights/timeline/bar";
import { type EpicLine, setEpicDates, type TaskLine } from "@/insights/timeline/data";
import { type Scale, widthOf, xOf } from "@/insights/timeline/scale";
import { setDue } from "@/tasks/actions";
import { useTaskLink } from "@/tasks/task-row";
import { Badge } from "@/ui/badge";
import { StatusIcon } from "@/ui/icons";
import { Tooltip } from "@/ui/tooltip";

/** The id of the hidden text that explains the keys; every bar points at it. */
export const KEYS_HINT_ID = "timeline-keys";

const row = "flex h-9 border-b border-line/70";
const nameCell = "sticky left-0 z-[3] flex w-[var(--tl-left)] shrink-0 items-center gap-1.5 border-r border-line bg-surface pr-2.5 text-sm";

const epicColor: Record<Epic["state"], string> = {
  planned: "var(--viz-todo)",
  active: "var(--viz-started)",
  paused: "var(--viz-waiting)",
  done: "var(--viz-done)",
  canceled: "var(--viz-backlog)",
};
const epicTone = { planned: "neutral", active: "accent", paused: "wait", done: "ok", canceled: "neutral" } as const;

const taskColor: Record<Category, string> = {
  backlog: "var(--viz-backlog)",
  unstarted: "var(--viz-todo)",
  started: "var(--viz-started)",
  waiting: "var(--viz-waiting)",
  done: "var(--viz-done)",
  canceled: "var(--viz-backlog)",
};

const lateBy = (day: number | undefined) => (day === undefined ? 0 : Math.max(0, -daysUntil(dayOf(day))));

/** A note that stays at the left edge of the track however far the scale is scrolled. */
function TrackNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="sticky left-[calc(var(--tl-left)+0.75rem)] z-[1] flex h-full w-max items-center gap-2 text-xs text-ink-3">
      {children}
    </span>
  );
}

const ghostButton =
  "inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-line-strong bg-surface px-2 text-xs font-medium text-ink-2 hover:border-ink-3 hover:text-ink";

interface EpicProps {
  line: EpicLine;
  projectKey: string;
  scale: Scale;
  today: number;
  open: boolean;
  onToggle: () => void;
}

export function EpicRow({ line, projectKey, scale, today, open, onToggle }: EpicProps) {
  const slug = useSlug();
  const { epic } = line;
  const closed = epic.state === "done" || epic.state === "canceled";
  const late = closed ? 0 : lateBy(line.target);
  const dated = line.start !== undefined || line.target !== undefined;
  const state = t(`epics.state.${epic.state}` as "epics.state.planned");

  return (
    <div className={row} style={{ width: `calc(var(--tl-left) + ${widthOf(scale)}px)` }}>
      <div className={cx(nameCell, "pl-1")}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "list.collapse" : "list.expand", { name: epic.name })}
          onClick={onToggle}
          className="flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-8"
        >
          <ChevronRight className={cx("size-4", open && "rotate-90")} aria-hidden />
        </button>
        <Link
          to={`/${slug}/p/${projectKey}/epics/${epic.id}`}
          title={epic.name}
          className={cx(
            "min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline",
            epic.state === "canceled" && "text-ink-3 line-through",
          )}
        >
          {epic.name}
        </Link>
        {late > 0 && <span className="shrink-0 text-xs font-medium text-danger tnum max-sm:hidden">{t("due.late", { n: late })}</span>}
        <Badge tone={epicTone[epic.state] ?? "neutral"} className="max-sm:hidden">
          {state}
        </Badge>
        <span
          className="w-8 shrink-0 text-right text-xs text-ink-3 tnum max-lg:hidden"
          title={t("ins.progress", { done: line.done, total: line.total })}
        >
          {line.done}/{line.total}
        </span>
      </div>
      <div className="relative" style={{ width: widthOf(scale) }}>
        {dated ? (
          <Bar
            name={t("timeline.bar.epic", { name: epic.name, state })}
            scale={scale}
            start={line.start}
            end={line.target}
            edit="both"
            tall
            color={epicColor[epic.state] ?? epicColor.planned}
            share={epic.state === "done" ? 1 : line.total > 0 ? line.done / line.total : 0}
            late={late > 0}
            describedBy={KEYS_HINT_ID}
            label={
              <>
                {line.target !== undefined && formatDay(dayOf(line.target))}
                {/* On a phone the names column has no room for the state, so it is written here. */}
                <span className="sm:hidden">
                  {line.target !== undefined && ", "}
                  {late > 0 ? t("timeline.stateLate", { state, late: t("due.late", { n: late }) }) : state}
                </span>
              </>
            }
            onChange={(next) => setEpicDates(epic, next)}
          />
        ) : (
          <TrackNote>
            {t("timeline.noDates")}
            <button type="button" className={ghostButton} onClick={() => setEpicDates(epic, { start: today, end: today + 13 })}>
              <Plus className="size-3" aria-hidden />
              {t("timeline.setDates")}
            </button>
          </TrackNote>
        )}
        {line.milestones.map(({ milestone, day }) => (
          <Diamond
            key={milestone.id}
            x={xOf(scale, day) + scale.dayW / 2}
            label={t("timeline.milestone", { name: milestone.name, day: formatDay(dayOf(day)) })}
          />
        ))}
      </div>
    </div>
  );
}

/** A milestone: a diamond on its day, named on hover and focus. */
function Diamond({ x, label }: { x: number; label: string }) {
  return (
    <Tooltip label={label} side="top">
      <span
        role="img"
        tabIndex={0}
        aria-label={label}
        className="absolute top-1/2 z-[1] flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
        style={{ left: x }}
      >
        <span className="size-2.5 rotate-45 rounded-[2px] bg-ink ring-2 ring-surface" />
      </span>
    </Tooltip>
  );
}

interface TaskProps {
  line: TaskLine;
  scale: Scale;
  today: number;
}

export function TaskLineRow({ line, scale, today }: TaskProps) {
  const { task, category } = line;
  const link = useTaskLink(task);
  const closed = category === "done" || category === "canceled";
  const late = closed ? 0 : lateBy(line.due);

  return (
    <div className={cx(row, "group/row")} style={{ width: `calc(var(--tl-left) + ${widthOf(scale)}px)` }}>
      <div className={cx(nameCell, "pl-9 max-sm:pl-3")}>
        <StatusIcon category={category} title={t(`category.${category}` as "category.done")} />
        <span className="w-14 shrink-0 truncate text-xs text-ink-3 tnum max-lg:hidden">{task.key}</span>
        <Link
          {...link}
          title={`${task.key} ${task.title}`}
          className={cx("min-w-0 flex-1 truncate underline-offset-2 hover:underline", closed && "text-ink-2")}
        >
          {task.title}
        </Link>
        {late > 0 && <span className="shrink-0 text-xs font-medium text-danger tnum max-sm:hidden">{t("due.late", { n: late })}</span>}
      </div>
      <div className="relative" style={{ width: widthOf(scale) }}>
        {line.due !== undefined ? (
          <Bar
            name={t("timeline.bar.task", { key: task.key, title: task.title })}
            scale={scale}
            start={line.start}
            end={line.due}
            edit="end"
            color={taskColor[category]}
            late={late > 0}
            describedBy={KEYS_HINT_ID}
            label={
              <>
                {formatDay(dayOf(line.due))}
                {late > 0 && <span className="sm:hidden">, {t("due.late", { n: late })}</span>}
              </>
            }
            onChange={(next) => next.end !== undefined && setDue([task], dayOf(next.end))}
          />
        ) : (
          <TrackNote>
            {t("timeline.noDue")}
            {!closed && (
              <button
                type="button"
                className={cx(
                  ghostButton,
                  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100",
                )}
                onClick={() => setDue([task], dayOf(today + 7))}
              >
                <Plus className="size-3" aria-hidden />
                {t("timeline.setDue")}
              </button>
            )}
          </TrackNote>
        )}
      </div>
    </div>
  );
}

/** The line under an open epic that has no tasks, and the heading over the tasks that have no epic. */
export function NoteRow({ scale, children, strong }: { scale: Scale; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className={row} style={{ width: `calc(var(--tl-left) + ${widthOf(scale)}px)` }}>
      <div className={cx(nameCell, strong ? "pl-1 font-medium" : "pl-9 text-xs text-ink-3 max-sm:pl-3")}>{children}</div>
      <div style={{ width: widthOf(scale) }} />
    </div>
  );
}

// A project's plan on a calendar: one row per epic from its start to its
// target date, opening to its tasks. Bars are dragged, or moved with the
// arrow keys, to change the dates.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChartGantt, ChevronRight, ChevronsDownUp, ChevronsUpDown, Keyboard } from "lucide-react";
import { Link, useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { keep, readKept } from "@/lib/kept";
import { useCan } from "@/lib/access";
import { useProjectByKey, useSlug } from "@/lib/selectors";
import { today } from "@/lib/time";
import type { Project } from "@/lib/types";
import { usePageTitle } from "@/lib/ui-state";
import { count } from "@/insights/lib/amounts";
import { dayNumber } from "@/lib/days";
import { useTimeline } from "@/insights/timeline/data";
import { Backdrop, ScaleHeader } from "@/insights/timeline/header";
import { LayoutTabs } from "@/insights/timeline/layout-tabs";
import { EpicRow, KEYS_HINT_ID, NoteRow, TaskLineRow } from "@/insights/timeline/rows";
import { DAY_WIDTH, frame, grow, type Scale, widthOf, xOf, type Zoom } from "@/insights/timeline/scale";
import { NotFoundPage } from "@/ui/not-found";
import { Button, IconButton } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

const ZOOM_KEY = "quadit.timeline.zoom";
const LOOSE = "no-epic";

const storedZoom = (): Zoom => (readKept<Zoom>(ZOOM_KEY, "weeks") === "months" ? "months" : "weeks");

/** /:ws/p/:key/timeline */
export function TimelinePage() {
  const project = useProjectByKey(useParams().key);
  return project ? <Timeline key={project.id} project={project} /> : <NotFoundPage />;
}

function Timeline({ project }: { project: Project }) {
  usePageTitle(t("timeline.pageTitle", { project: project.name }));
  const slug = useSlug();
  const [zoom, setZoom] = useState<Zoom>(storedZoom);
  const [showCanceled, setShowCanceled] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const data = useTimeline(project.id, showCanceled);
  const readOnly = !useCan().edit(project.id);
  const now = dayNumber(today());

  // The days shown only ever grow while the page is open, so nothing jumps when a date moves.
  const [range, setRange] = useState(() => frame(data.extent, now));
  const wider = grow(range, data.extent, now);
  if (wider !== range) setRange(wider);
  const scale: Scale = useMemo(() => ({ ...range, zoom, dayW: DAY_WIDTH[zoom] }), [range, zoom]);

  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<{ start: number; dayW: number; left: number } | null>(null);
  const trackView = (el: HTMLElement) =>
    el.clientWidth - (el.querySelector<HTMLElement>("[data-names]")?.offsetWidth ?? 0);
  const todayLeft = (el: HTMLElement) => Math.max(0, xOf(scale, now) - trackView(el) * 0.3);

  // Start with today in view; after that, keep the same day at the left edge when the zoom or the first day changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const was = seen.current;
    if (!was) el.scrollLeft = todayLeft(el);
    else if (was.start !== scale.start || was.dayW !== scale.dayW)
      el.scrollLeft = (was.start + was.left / was.dayW - scale.start) * scale.dayW;
    seen.current = { start: scale.start, dayW: scale.dayW, left: el.scrollLeft };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- todayLeft reads the scale this effect already depends on
  }, [scale.start, scale.dayW]);

  function pickZoom(next: Zoom) {
    setZoom(next);
    keep(ZOOM_KEY, next);
  }

  function goToday() {
    const el = scroller.current;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollTo({ left: todayLeft(el), behavior: calm ? "auto" : "smooth" });
  }

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allIds = [...data.epics.map((l) => l.epic.id), ...(data.loose.length ? [LOOSE] : [])];
  const allOpen = allIds.length > 0 && allIds.every((id) => open.has(id));
  const empty = data.epics.length === 0 && data.loose.length === 0;
  const keysHint = t("timeline.keys");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-2 no-scrollbar md:px-3">
        <LayoutTabs projectKey={project.key} />
        <div
          role="radiogroup"
          aria-label={t("timeline.zoom")}
          className="flex shrink-0 items-center rounded-md border border-line p-0.5"
        >
          {(["weeks", "months"] as const).map((z) => (
            <button
              key={z}
              type="button"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a button drawn as one of a set of choices; a native radio would need a hidden input and a label
              role="radio"
              aria-checked={zoom === z}
              onClick={() => pickZoom(z)}
              className={cx(
                "h-5.5 rounded-sm px-2 text-xs font-medium",
                zoom === z ? "bg-press text-ink" : "text-ink-2 hover:text-ink",
              )}
            >
              {t(`timeline.zoom.${z}`)}
            </button>
          ))}
        </div>
        <Button onClick={goToday}>{t("timeline.today")}</Button>
        {data.canceled > 0 && (
          <Button variant="ghost" aria-pressed={showCanceled} onClick={() => setShowCanceled(!showCanceled)}>
            {showCanceled ? t("timeline.hideCanceled") : t("timeline.showCanceled", { n: data.canceled })}
          </Button>
        )}
        <span className="flex-1" />
        <p className="shrink-0 text-xs text-ink-3 max-2xl:hidden">{keysHint}</p>
        <IconButton label={keysHint} className="2xl:hidden">
          <Keyboard className="size-4" />
        </IconButton>
        <p id={KEYS_HINT_ID} className="sr-only">
          {keysHint}
        </p>
      </div>

      {empty ? (
        <EmptyState
          icon={<ChartGantt />}
          title={t("timeline.empty")}
          hint={t("timeline.emptyHint")}
          action={
            <Link
              to={`/${slug}/p/${project.key}/epics`}
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              {t("timeline.goEpics")}
            </Link>
          }
        />
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => seen.current && (seen.current.left = e.currentTarget.scrollLeft)}
          className="min-h-0 flex-1 overflow-auto overscroll-contain [--tl-left:9.5rem] sm:[--tl-left:17rem] lg:[--tl-left:22rem]"
        >
          <div
            className="relative flex min-h-full flex-col"
            style={{ width: `calc(var(--tl-left) + ${widthOf(scale)}px)` }}
          >
            <div className="sticky top-0 z-[5] flex h-11 border-b border-line bg-surface">
              <div
                data-names
                className="sticky left-0 z-[1] flex w-[var(--tl-left)] shrink-0 items-center gap-1 border-r border-line bg-surface pr-1.5 pl-1"
              >
                <IconButton
                  label={t(allOpen ? "timeline.collapseAll" : "timeline.expandAll")}
                  onClick={() => setOpen(allOpen ? new Set() : new Set(allIds))}
                >
                  {allOpen ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
                </IconButton>
                <span className="text-xs font-medium text-ink-2">{t("timeline.count", { n: data.epics.length })}</span>
              </div>
              <ScaleHeader scale={scale} today={now} />
            </div>
            <Backdrop scale={scale} today={now} />

            {data.epics.map((line) => (
              <section key={line.epic.id} aria-label={line.epic.name}>
                <EpicRow
                  line={line}
                  projectKey={project.key}
                  scale={scale}
                  today={now}
                  open={open.has(line.epic.id)}
                  onToggle={() => toggle(line.epic.id)}
                  readOnly={readOnly}
                />
                {open.has(line.epic.id) &&
                  (line.tasks.length === 0 ? (
                    <NoteRow scale={scale}>{t("timeline.noTasks")}</NoteRow>
                  ) : (
                    line.tasks.map((task) => <TaskLineRow key={task.task.id} line={task} scale={scale} today={now} />)
                  ))}
              </section>
            ))}

            {data.loose.length > 0 && (
              <section aria-label={t("timeline.noEpicLong")}>
                <NoteRow scale={scale} strong>
                  <button
                    type="button"
                    aria-expanded={open.has(LOOSE)}
                    aria-label={t(open.has(LOOSE) ? "list.collapse" : "list.expand", { name: t("timeline.noEpic") })}
                    onClick={() => toggle(LOOSE)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-8"
                  >
                    <ChevronRight className={cx("size-4", open.has(LOOSE) && "rotate-90")} aria-hidden />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={t("timeline.noEpicLong")}>
                    {t("timeline.noEpic")}
                  </span>
                  <span className="text-xs font-normal text-ink-3 tnum">{count(data.loose.length)}</span>
                </NoteRow>
                {open.has(LOOSE) &&
                  data.loose.map((task) => <TaskLineRow key={task.task.id} line={task} scale={scale} today={now} />)}
              </section>
            )}
            {/* The names column runs to the bottom, so the rules behind the rows never show through it. */}
            <div
              aria-hidden
              className="sticky left-0 z-[3] w-[var(--tl-left)] flex-1 border-r border-line bg-surface"
            />
          </div>
        </div>
      )}
    </div>
  );
}

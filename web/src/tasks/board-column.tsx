import { type FormEvent, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { defaultRangeExtractor, type Range, useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useLocation } from "react-router";
import { Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { usePlace } from "@/lib/place";
import { rankBetween } from "@/lib/rank";
import { useRestLoaded, useStore } from "@/lib/store";
import { isOpenCategory, type Project, type Task } from "@/lib/types";
import { createTask, type NewTask } from "@/tasks/actions";
import { BoardCard } from "@/tasks/board-card";
import { NONE, type TaskGroup } from "@/tasks/filters";
import { GroupCount, GroupIcon } from "@/tasks/group-header";
import { renameStatus, StatusMenu } from "@/tasks/status-menu";
import { IconButton } from "@/ui/button";

/** A task as it sits in one column. */
export interface Card {
  id: string;
  task: Task;
}

interface Props {
  group: TaskGroup;
  /** The cards in the order to show them (it differs from the group's while a card is dragged over). */
  cards: Card[];
  /** Quick-add needs one project to create in; without it the button is not shown. */
  project: Project | undefined;
  /** The card being dragged, which stays drawn wherever the column is scrolled to. */
  activeId: string | null;
  /** The column is a status the viewer may rename, recolour, move and delete. */
  editable: boolean;
}

/** What a task added from this column starts with. */
function fieldsFor(group: TaskGroup): Partial<NewTask> {
  if (group.kind === "status") return { statusId: group.value };
  if (group.kind === "assignee" && group.value !== NONE) return { assigneeId: group.value };
  if (group.kind === "label" && group.value !== NONE) return { labelIds: [group.value] };
  return {};
}

const GAP = 6;
const NO_FOCUS = () => ({ focus: null });

/**
 * The heights of a column's cards as they were measured, by step of the
 * history and column. A column drawn anew only guesses the heights of the
 * cards above the ones in view, so scrolled back to the same number it
 * would show slightly different cards; with the heights it had, it shows
 * the same ones.
 */
const measured = new Map<string, VirtualItem[]>();
const MEASURED_KEPT = 40;

/** One column of cards, with a quick-add box at the top. Only the cards in view are drawn. */
export const BoardColumn = memo(function BoardColumn({ group, cards, project, activeId, editable }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const scroller = useRef<HTMLDivElement | null>(null);
  const status = useStore((s) => (editable ? s.c.statuses[group.value] : undefined));
  // A Done or Canceled column is not empty while the finished work is still on its way; its header says so.
  const waitingForRest = !useRestLoaded() && group.kind === "status" && !isOpenCategory(group.category);

  // Come back to, the column is scrolled where it was (lib/place.ts), with the cards there drawn from the start.
  const part = `column:${group.id}`;
  const saved = usePlace(scroller, NO_FOCUS, part);
  const heightsAt = `${useLocation().key}#${part}`;
  const activeIndex = activeId ? cards.findIndex((card) => card.id === activeId) : -1;
  const virtual = useVirtualizer({
    count: cards.length,
    initialOffset: saved?.top ?? 0,
    initialMeasurementsCache: measured.get(heightsAt),
    getScrollElement: () => scroller.current,
    estimateSize: () => 76,
    gap: GAP,
    overscan: 6,
    getItemKey: (index) => cards[index]?.id ?? index,
    // The dragged card must not leave the page when its place scrolls out of view.
    rangeExtractor: useCallback(
      (range: Range) => {
        const shown = defaultRangeExtractor(range);
        return activeIndex >= 0 && !shown.includes(activeIndex) ? [...shown, activeIndex].sort((a, b) => a - b) : shown;
      },
      [activeIndex],
    ),
  });
  useLayoutEffect(
    () => () => {
      measured.delete(heightsAt);
      measured.set(heightsAt, virtual.measurementsCache);
      if (measured.size > MEASURED_KEPT) measured.delete(measured.keys().next().value as string);
    },
    [heightsAt, virtual],
  );
  const items = virtual.getVirtualItems();
  const shownIds = useMemo(() => items.map((item) => cards[item.index]?.id).filter((id): id is string => !!id), [items, cards]);

  function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !project) return;
    setTitle("");
    // New cards go on top, where the box is.
    createTask({ projectId: project.id, title: text, rank: rankBetween(undefined, cards[0]?.task.rank), ...fieldsFor(group) }).catch(() => {});
    virtual.scrollToOffset(0);
  }

  return (
    <section aria-label={group.title} className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-sunken max-sm:w-[82vw]">
      <header className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <GroupIcon group={group} />
        {renaming && status ? (
          <RenameBox
            initial={status.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== status.name) renameStatus(status, name);
            }}
          />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-sm font-medium">{group.title}</h2>
            <GroupCount group={group} count={cards.length} className="flex-1" />
          </>
        )}
        {status && project && !renaming && <StatusMenu status={status} project={project} onRename={() => setRenaming(true)} />}
        {project && !renaming && (
          <IconButton size="sm" label={t("board.add", { name: group.title })} onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <Plus className="size-3.5" />
          </IconButton>
        )}
      </header>

      {adding && (
        <form onSubmit={add} className="px-2 pb-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            onBlur={() => !title.trim() && setAdding(false)}
            placeholder={t("board.addPlaceholder")}
            aria-label={t("board.add", { name: group.title })}
            className="h-8 w-full rounded-md border border-accent bg-surface px-2.5 text-sm outline-none ring-2 ring-accent/25"
          />
        </form>
      )}

      <SortableContext items={shownIds} strategy={verticalListSortingStrategy}>
        <div
          ref={(el) => {
            scroller.current = el;
            setNodeRef(el);
          }}
          className={cx("min-h-16 flex-1 overflow-y-auto px-2 pb-2 transition-colors", isOver && cards.length === 0 && "bg-hover")}
        >
          <div className="relative" style={{ height: virtual.getTotalSize() }}>
            {items.map((item) => {
              const card = cards[item.index];
              if (!card) return null;
              return (
                <div key={card.id} data-index={item.index} ref={virtual.measureElement} className="absolute inset-x-0" style={{ top: item.start }}>
                  <BoardCard id={card.id} task={card.task} />
                </div>
              );
            })}
          </div>
          {cards.length === 0 && !adding && (waitingForRest ? null : <p className="px-1 pt-1 text-xs text-ink-3">{t("board.empty")}</p>)}
        </div>
      </SortableContext>
    </section>
  );
});

/** The column's name as a box to retype it: Enter keeps the new name, Escape the old one. */
function RenameBox({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(name.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name.trim() || null);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      aria-label={t("col.renameLabel", { name: initial })}
      className="h-6 min-w-0 flex-1 rounded-sm border border-accent bg-surface px-1.5 text-sm font-medium outline-none ring-2 ring-accent/25"
    />
  );
}

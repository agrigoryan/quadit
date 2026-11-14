import { type FormEvent, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { rankBetween } from "@/lib/rank";
import type { Task } from "@/lib/types";
import { createTask } from "@/tasks/actions";
import { BoardCard } from "@/tasks/board-card";
import type { TaskGroup } from "@/tasks/filters";
import { GroupIcon } from "@/tasks/group-header";
import { IconButton } from "@/ui/button";

interface Props {
  group: TaskGroup;
  /** The cards in the order to show them (it differs from the group's while a card is dragged over). */
  tasks: Task[];
  /** Quick-add needs one project to create in; without it the button is not shown. */
  projectId: string | undefined;
}

/** One status as a column of cards, with a quick-add box at the top. */
export function BoardColumn({ group, tasks, projectId }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !projectId) return;
    setTitle("");
    // New cards go on top, where the box is.
    createTask({ projectId, title: text, statusId: group.value, rank: rankBetween(undefined, tasks[0]?.rank) }).catch(() => {});
  }

  return (
    <section aria-label={group.title} className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-sunken max-sm:w-[82vw]">
      <header className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <GroupIcon group={group} />
        <h2 className="min-w-0 truncate text-sm font-medium">{group.title}</h2>
        <span className="flex-1 text-xs text-ink-3 tnum">{tasks.length}</span>
        {projectId && (
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

      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cx("flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 transition-colors", isOver && tasks.length === 0 && "bg-hover")}
        >
          {tasks.map((task) => (
            <BoardCard key={task.id} task={task} />
          ))}
          {tasks.length === 0 && !adding && <p className="px-1 pt-1 text-xs text-ink-3">{t("board.empty")}</p>}
        </div>
      </SortableContext>
    </section>
  );
}

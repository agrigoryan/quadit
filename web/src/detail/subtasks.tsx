// The tasks that are parts of this one: how far along they are, each as a
// row that opens it, and a box that adds the next one on Enter.

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { rowAction } from "@/detail/row-action";
import { Section } from "@/detail/section";
import { createTask, setParent } from "@/tasks/actions";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { AssigneeAvatar } from "@/tasks/task-chips";
import { useTaskLink } from "@/lib/task-link";
import { IconButton } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";

function SubtaskRow({ task }: { task: Task }) {
  const status = useStore((s) => s.c.statuses[task.status_id]);
  const link = useTaskLink(task);
  const closed = status?.category === "done" || status?.category === "canceled";
  return (
    <li className="group relative -mx-1.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover max-md:h-10">
      {status && (
        <TaskPropertyPicker kind="status" tasks={[task]}>
          <button
            type="button"
            aria-label={`${t("prop.status")}: ${status.name}`}
            className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-sunken data-[state=open]:bg-sunken"
          >
            <StatusIcon category={status.category} />
          </button>
        </TaskPropertyPicker>
      )}
      <span className="shrink-0 text-xs text-ink-3 tnum">{task.key}</span>
      <Link
        {...link}
        className={cx(
          "min-w-0 flex-1 truncate py-1.5 outline-none after:absolute after:inset-0 after:content-['']",
          closed && "text-ink-2",
        )}
      >
        {task.title}
      </Link>
      <IconButton
        label={t("detail.subtasks.detach", { key: task.key })}
        size="sm"
        className={cx("relative z-[1]", rowAction)}
        onClick={() => setParent([task], null)}
      >
        <X className="size-3.5" />
      </IconButton>
      <span className="relative z-[1] flex shrink-0">
        <AssigneeAvatar userId={task.assignee_id} />
      </span>
    </li>
  );
}

function QuickAdd({ parent, autoFocus }: { parent: Task; autoFocus?: boolean }) {
  const [title, setTitle] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function add() {
    const text = title.trim();
    if (!text) return;
    setTitle("");
    // A refusal is already shown as a toast; the box stays ready for the next one.
    createTask({ projectId: parent.project_id, title: text, parentId: parent.id }).catch(() => {});
    input.current?.focus();
  }

  return (
    <div className="-mx-1.5 mt-0.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 focus-within:bg-sunken max-md:h-10">
      <span className="flex size-6 shrink-0 items-center justify-center text-ink-3">
        <Plus className="size-3.5" aria-hidden />
      </span>
      <input
        ref={input}
        autoFocus={autoFocus}
        value={title}
        aria-label={t("detail.subtasks.add")}
        placeholder={t("detail.subtasks.placeholder")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape" && title) {
            e.stopPropagation();
            setTitle("");
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

interface Props {
  task: Task;
  subtasks: Task[];
  /** Put the caret in the add box as soon as it appears. */
  focusAdd?: boolean;
}

export function Subtasks({ task, subtasks, focusAdd }: Props) {
  const statuses = useStore((s) => s.c.statuses);
  const total = subtasks.length;
  const done = subtasks.filter((tk) => {
    const category = statuses[tk.status_id]?.category;
    return category === "done" || category === "canceled";
  }).length;

  return (
    <Section
      title={t("detail.subtasks")}
      meta={
        total > 0 && (
          <span className="flex items-center gap-2 text-xs text-ink-3 tnum">
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-label={t("task.subtasks", { done, total })}
              className="block h-1 w-16 overflow-hidden rounded-full bg-sunken"
            >
              <span
                className="block h-full rounded-full bg-ok transition-[width] duration-150"
                style={{ width: `${(done / total) * 100}%` }}
              />
            </span>
            {t("detail.subtasks.progress", { done, total })}
          </span>
        )
      }
    >
      {total > 0 && (
        <ul>
          {subtasks.map((sub) => (
            <SubtaskRow key={sub.id} task={sub} />
          ))}
        </ul>
      )}
      {!task.deleted_at && <QuickAdd parent={task} autoFocus={focusAdd} />}
    </Section>
  );
}

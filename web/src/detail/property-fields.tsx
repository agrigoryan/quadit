// The pieces of the properties block: one labelled row, the button a value
// sits in, and the values that are typed rather than picked (the waiting
// note, the estimate, the due date) or picked from tasks (the parent).

import { type ButtonHTMLAttributes, type ReactNode, type Ref, useCallback, useMemo, useState } from "react";
import { ArrowUpRight, CircleSlash, X } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useTask } from "@/lib/selectors";
import type { Task } from "@/lib/types";
import { setDue, setEstimate, setParent, setWaitingOn, setWaitingOutside, waitsOutside } from "@/tasks/actions";
import { useTaskLink } from "@/tasks/task-link";
import { TaskPicker } from "@/detail/task-picker";
import { Textarea } from "@/ui/input";
import { Tooltip } from "@/ui/tooltip";

/** One property: its name at the left, its value at the right. */
export function PropRow({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("flex min-w-0 items-start gap-2", wide && "sm:col-span-2")}>
      <dt className="w-[5.5rem] shrink-0 py-[5px] text-xs text-ink-2 max-md:py-[9px]">{label}</dt>
      <dd className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 max-md:min-h-9">{children}</dd>
    </div>
  );
}

const valueBox =
  "-ml-1.5 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sm max-md:h-9 " +
  "hover:bg-hover data-[state=open]:bg-hover disabled:pointer-events-none";

interface PropButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Nothing is set: shown faintly. */
  empty?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** The clickable value of a property; opens its picker. */
export function PropButton({ empty, className, type = "button", ...rest }: PropButtonProps) {
  return <button type={type} className={cx(valueBox, empty ? "text-ink-3" : "text-ink", className)} {...rest} />;
}

const inlineField =
  "-ml-1.5 h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-ink outline-none max-md:h-9 " +
  "hover:bg-hover focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 read-only:pointer-events-none";

/**
 * The note that says what whoever the task waits on should do. Saved on
 * Enter or on leaving the box. It grows to show a long note whole; `below`
 * puts it on a line of its own under the name, where the column is narrow.
 */
export function WaitingNote({ task, below }: { task: Task; below?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = task.waiting_on_note ?? "";

  function save() {
    if (draft === null) return;
    const next = draft.replace(/\s+/g, " ").trim();
    if (next !== saved) {
      if (waitsOutside(task)) setWaitingOutside([task], next);
      else setWaitingOn([task], task.waiting_on_id ?? null, next);
    }
    setDraft(null);
  }

  return (
    <Textarea
      bare
      autoGrow
      rows={1}
      aria-label={t("detail.waitingNote")}
      placeholder={waitsOutside(task) ? t("prop.outside.placeholder") : t("detail.waitingNotePlaceholder")}
      readOnly={!!task.deleted_at}
      value={draft ?? saved}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(
        "w-auto min-w-32 flex-1 rounded-md border border-transparent px-1.5 py-[3px] text-sm leading-5 not-focus:text-ink-2 max-md:py-[7px] max-sm:-ml-1.5 max-sm:basis-full",
        "hover:bg-hover focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 read-only:pointer-events-none",
        below && "lg:-ml-1.5 lg:basis-full",
      )}
    />
  );
}

export function EstimateField({ task }: { task: Task }) {
  const [draft, setDraft] = useState<string | null>(null);

  function save() {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    const next = draft.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    if (next !== (task.estimate ?? null)) setEstimate([task], next);
    setDraft(null);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={t("prop.estimate")}
      placeholder={t("detail.estimatePlaceholder")}
      readOnly={!!task.deleted_at}
      value={draft ?? (task.estimate ? String(task.estimate) : "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(inlineField, "w-20 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
    />
  );
}

/** The browser's own date field, dressed to sit in the grid, with a way to clear it. */
export function DueField({ task }: { task: Task }) {
  return (
    <>
      <input
        type="date"
        aria-label={t("prop.due")}
        readOnly={!!task.deleted_at}
        value={task.due_on ?? ""}
        onChange={(e) => setDue([task], e.target.value || null)}
        className={cx(inlineField, "tnum", !task.due_on && "text-ink-3 focus:text-ink")}
      />
      {task.due_on && !task.deleted_at && (
        <Tooltip label={t("prop.clearDue")}>
          <button
            type="button"
            aria-label={t("prop.clearDue")}
            onClick={() => setDue([task], null)}
            className="flex size-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-9"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      )}
    </>
  );
}

const NO_PARENT = "none";

function OpenTaskLink({ task }: { task: Task }) {
  const link = useTaskLink(task);
  const label = t("detail.openParent", { key: task.key });
  return (
    <Tooltip label={label}>
      <Link
        {...link}
        aria-label={label}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink max-md:size-9"
      >
        <ArrowUpRight className="size-3.5" />
      </Link>
    </Tooltip>
  );
}

/** The task this one is a part of: any task of the same project that is not below it. */
export function ParentField({ task }: { task: Task }) {
  const parent = useTask(task.parent_id);
  const tasks = useCollection("tasks");

  // A task cannot sit under itself or under anything that sits under it.
  const below = useMemo(() => {
    const children: Record<string, string[]> = {};
    for (const tk of Object.values(tasks)) if (tk.parent_id) (children[tk.parent_id] ??= []).push(tk.id);
    const out = new Set<string>([task.id]);
    const stack = [task.id];
    for (let id = stack.pop(); id; id = stack.pop()) {
      for (const child of children[id] ?? []) {
        if (!out.has(child)) {
          out.add(child);
          stack.push(child);
        }
      }
    }
    return out;
  }, [tasks, task.id]);

  const filter = useCallback((tk: Task) => tk.project_id === task.project_id && !below.has(tk.id), [task.project_id, below]);
  const extra = useMemo(
    () => [{ id: NO_PARENT, label: t("task.noParent"), icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden /> }],
    [],
  );

  return (
    <>
      <TaskPicker
        filter={filter}
        value={task.parent_id ?? NO_PARENT}
        extra={extra}
        label={t("prop.set.parent")}
        onPick={(id) => setParent([task], id === NO_PARENT ? null : id)}
      >
        <PropButton
          empty={!parent}
          disabled={!!task.deleted_at}
          aria-label={`${t("prop.parent")}: ${parent ? parent.key : t("task.noParent")}`}
          // Room is left for the arrow that opens the parent, so a long title does not push it onto a line of its own.
          className={parent ? "max-w-[calc(100%-1.75rem)]" : undefined}
        >
          {parent ? (
            <>
              <span className="shrink-0 text-xs text-ink-3 tnum">{parent.key}</span>
              <span className="truncate">{parent.title}</span>
            </>
          ) : (
            t("task.noParent")
          )}
        </PropButton>
      </TaskPicker>
      {parent && <OpenTaskLink task={parent} />}
    </>
  );
}

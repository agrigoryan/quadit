// An epic's tasks, grouped by milestone: each milestone with its date and
// its own progress, its tasks as ordinary task rows, and a last group for
// tasks in no milestone. Milestones can be added, renamed, dated, moved up
// or down and deleted; a task changes milestone from the mark at its right.

import { type FormEvent, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Diamond, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { findTaskByKey, sortByRank, useCollection } from "@/lib/selectors";
import { getState } from "@/lib/store";
import type { Epic, Milestone, Task } from "@/lib/types";
import { count } from "@/insights/lib/format";
import { createMilestone, deleteMilestone, moveMilestone, updateMilestone } from "@/insights/plan/actions";
import { tallyOf } from "@/insights/plan/stats";
import { ProgressCount } from "@/insights/ui/progress";
import { createTask, setMilestone } from "@/tasks/actions";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { keyColumn, TaskRow } from "@/tasks/task-row";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

/** Creates a task in the epic and, when given, puts it in the milestone. */
async function addTask(epic: Epic, milestone: Milestone | undefined, title: string) {
  try {
    const key = await createTask({ projectId: epic.project_id, title, epicId: epic.id });
    const task = findTaskByKey(getState().c.tasks, key);
    if (task && milestone) setMilestone([task], milestone.id);
  } catch {
    // The server's reason is already shown.
  }
}

function QuickAdd({ epic, milestone, onDone }: { epic: Epic; milestone?: Milestone; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return onDone();
    void addTask(epic, milestone, trimmed);
    setTitle("");
  };
  return (
    <form onSubmit={submit} className="flex h-9 items-center gap-2 border-b border-line/70 pr-3 pl-9">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onDone())}
        onBlur={() => !title.trim() && onDone()}
        placeholder={t("epic.taskPlaceholder")}
        aria-label={t("epic.taskPlaceholder")}
        className="h-7 flex-1"
      />
      <Button type="submit" variant="primary" disabled={!title.trim()}>
        {t("common.add")}
      </Button>
    </form>
  );
}

interface GroupProps {
  epic: Epic;
  milestone?: Milestone;
  ordered: Milestone[];
  tasks: Task[];
}

function Group({ epic, milestone, ordered, tasks }: GroupProps) {
  const statuses = useCollection("statuses");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const tally = tallyOf(tasks, statuses);
  const name = milestone?.name ?? t("epic.noMilestone");
  const at = milestone ? ordered.indexOf(milestone) : -1;

  function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = new FormData(e.currentTarget).get("name")?.toString().trim();
    if (milestone && next && next !== milestone.name) updateMilestone(milestone, { name: next });
    setRenaming(false);
  }

  return (
    <section aria-label={name} style={keyColumn(tasks.map((task) => task.key))}>
      <div className="sticky top-0 z-[2] flex min-h-9 flex-wrap items-center gap-x-2 border-b border-line bg-sunken py-1 pr-2 pl-3">
        <div className={cx("flex min-w-0 flex-1 items-center gap-2", milestone && "max-sm:min-h-7 max-sm:basis-full")}>
          <Diamond className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          {milestone && renaming ? (
            <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                name="name"
                autoFocus
                defaultValue={milestone.name}
                maxLength={120}
                aria-label={t("epic.milestoneName")}
                className="h-7 max-w-80"
                onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(false))}
              />
            </form>
          ) : (
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
              {name}
              <span className="ml-2 text-xs font-normal text-ink-3 tnum">{count(tasks.length)}</span>
            </h3>
          )}
        </div>
        {milestone && (
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3 max-sm:pl-5.5">
            <span className="max-sm:sr-only">{t("epic.milestoneDate")}</span>
            <Input
              type="date"
              value={milestone.target_on ?? ""}
              onChange={(e) => updateMilestone(milestone, { target_on: e.target.value || null })}
              className="h-6 w-[7.75rem] px-1.5 text-xs tnum"
            />
          </label>
        )}
        <span className="flex-1 sm:hidden" />
        <ProgressCount done={tally.done} started={tally.started} total={tally.total} />
        <IconButton size="sm" label={t("list.addTo", { name })} onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
        </IconButton>
        {milestone && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton size="sm" label={t("epic.milestoneActions", { name })}>
                <Ellipsis className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
                {t("epic.rename")}
              </MenuItem>
              <MenuItem icon={<ArrowUp />} disabled={at <= 0} onSelect={() => moveMilestone(ordered, milestone, -1)}>
                {t("epic.moveUp")}
              </MenuItem>
              <MenuItem icon={<ArrowDown />} disabled={at >= ordered.length - 1} onSelect={() => moveMilestone(ordered, milestone, 1)}>
                {t("epic.moveDown")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} danger onSelect={() => deleteMilestone(milestone)}>
                {t("epic.deleteMilestone")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {tasks.length === 0 && !adding && (
        <p className="border-b border-line/70 py-2 pr-3 pl-9 text-xs text-ink-3">
          {t(milestone ? "epic.milestoneEmpty" : "epic.allInMilestones")}
        </p>
      )}
      {tasks.map((task) => (
        <div key={task.id} className="flex items-stretch">
          <div className="min-w-0 flex-1">
            <TaskRow task={task} hide={{ epic: true }} />
          </div>
          {ordered.length > 0 && (
            <div className="flex items-center border-b border-line/70 pr-2">
              <TaskPropertyPicker kind="milestone" tasks={[task]} align="end">
                <IconButton size="sm" label={t("epic.moveTask", { key: task.key })}>
                  <Diamond className="size-3.5" />
                </IconButton>
              </TaskPropertyPicker>
            </div>
          )}
        </div>
      ))}
      {adding && <QuickAdd epic={epic} milestone={milestone} onDone={() => setAdding(false)} />}
    </section>
  );
}

function NewMilestone({ epic, last }: { epic: Epic; last: Milestone | undefined }) {
  const [name, setName] = useState("");
  const [day, setDay] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMilestone(epic, name, day, last);
    setName("");
    setDay("");
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Diamond className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        placeholder={t("epic.milestonePlaceholder")}
        aria-label={t("epic.milestonePlaceholder")}
        className="h-7 min-w-40 flex-1 basis-40 sm:max-w-72"
      />
      <span className="w-36 shrink-0">
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label={t("epic.milestoneDate")} className="h-7 tnum" />
      </span>
      <Button type="submit" disabled={!name.trim()}>
        <Plus className="size-4" aria-hidden />
        {t("epic.addMilestone")}
      </Button>
    </form>
  );
}

export function EpicMilestones({ epic, tasks }: { epic: Epic; tasks: Task[] }) {
  const all = useCollection("milestones");
  const ordered = useMemo(() => sortByRank(Object.values(all).filter((m) => m.epic_id === epic.id && !m.deleted_at)), [all, epic.id]);
  const known = new Set(ordered.map((m) => m.id));
  const loose = tasks.filter((task) => !task.milestone_id || !known.has(task.milestone_id));
  return (
    <div>
      {ordered.map((m) => (
        <Group key={m.id} epic={epic} milestone={m} ordered={ordered} tasks={tasks.filter((task) => task.milestone_id === m.id)} />
      ))}
      {(loose.length > 0 || ordered.length === 0) && <Group epic={epic} ordered={ordered} tasks={loose} />}
      <NewMilestone epic={epic} last={ordered[ordered.length - 1]} />
    </div>
  );
}

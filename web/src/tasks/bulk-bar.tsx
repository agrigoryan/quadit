import { memo, useRef, useState } from "react";
import {
  CalendarDays,
  CircleDot,
  Ellipsis,
  FolderInput,
  Gauge,
  Layers,
  RefreshCw,
  Tag,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { setDue, setEstimate, trashTasks } from "@/tasks/actions";
import { type TaskProperty, TaskPropertyPicker } from "@/tasks/property-picker";
import { Button, IconButton } from "@/ui/button";
import { PriorityIcon } from "@/ui/icons";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";

interface Props {
  tasks: Task[];
  onClear: () => void;
}

const actions: { kind: TaskProperty; label: () => string; icon: React.ReactNode }[] = [
  { kind: "status", label: () => t("prop.status"), icon: <CircleDot className="size-3.5" aria-hidden /> },
  { kind: "assignee", label: () => t("prop.assignee"), icon: <UserRound className="size-3.5" aria-hidden /> },
  { kind: "priority", label: () => t("prop.priority"), icon: <PriorityIcon priority={2} title="" /> },
  { kind: "labels", label: () => t("prop.labels"), icon: <Tag className="size-3.5" aria-hidden /> },
];

/** What the "More" menu opens next to itself. */
type More = "epic" | "cycle" | "project" | "due" | "estimate";

/** Floats above the list while tasks are selected: change them all at once, as one batch. */
export const BulkBar = memo(function BulkBar({ tasks, onClear }: Props) {
  const [more, setMore] = useState<More | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** Set when a menu entry opens something of its own, so the closing menu does not take the focus back. */
  const handingOver = useRef(false);
  const cycles = useStore((s) => !!s.c.projects[tasks[0]?.project_id ?? ""]?.settings?.cycles);
  const estimates = useStore((s) => s.c.projects[tasks[0]?.project_id ?? ""]?.settings?.estimates !== false);
  if (tasks.length === 0) return null;

  const open = (what: More) => () => {
    handingOver.current = true;
    setMore(what);
  };
  // What the menu opened has no trigger of its own; the focus goes back to the menu's button.
  const close = () => {
    setMore(null);
    moreButton.current?.focus();
  };
  const picker = more === "epic" || more === "cycle" || more === "project" ? more : null;

  return (
    <div
      role="toolbar"
      aria-label={t("bulk.selected", { n: tasks.length })}
      className="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 overflow-x-auto rounded-lg bg-surface p-1.5 pl-3 shadow-pop no-scrollbar animate-pop"
    >
      <span className="mr-1 shrink-0 text-sm font-medium tnum">{t("bulk.selected", { n: tasks.length })}</span>
      {actions.map((a) => (
        <TaskPropertyPicker key={a.kind} kind={a.kind} tasks={tasks} side="top">
          <Button size="md" className="max-sm:px-2" aria-label={a.label()}>
            {a.icon}
            <span className="max-sm:hidden">{a.label()}</span>
          </Button>
        </TaskPropertyPicker>
      ))}

      <Menu>
        <MenuTrigger asChild>
          <Button ref={moreButton} size="md" className="max-sm:px-2" aria-label={t("bulk.more")}>
            <Ellipsis className="size-3.5" aria-hidden />
            <span className="max-sm:hidden">{t("common.more")}</span>
          </Button>
        </MenuTrigger>
        <MenuContent
          side="top"
          align="end"
          onCloseAutoFocus={(e) => {
            if (handingOver.current) e.preventDefault();
            handingOver.current = false;
          }}
        >
          <MenuItem icon={<Layers />} onSelect={open("epic")}>
            {t("prop.set.epic")}
          </MenuItem>
          {cycles && (
            <MenuItem icon={<RefreshCw />} onSelect={open("cycle")}>
              {t("prop.set.cycle")}
            </MenuItem>
          )}
          <MenuItem icon={<CalendarDays />} onSelect={open("due")}>
            {t("bulk.due")}
          </MenuItem>
          {estimates && (
            <MenuItem icon={<Gauge />} onSelect={open("estimate")}>
              {t("bulk.estimate")}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<FolderInput />} onSelect={open("project")}>
            {t("bulk.move")}
          </MenuItem>
        </MenuContent>
      </Menu>
      {picker && (
        <TaskPropertyPicker
          kind={picker}
          tasks={tasks}
          open
          onOpenChange={(next) => !next && close()}
          anchor={moreButton}
          side="top"
          align="end"
        />
      )}
      {(more === "due" || more === "estimate") && (
        <Popover open onOpenChange={(next) => !next && close()}>
          <PopoverAnchor virtualRef={moreButton} />
          <PopoverContent side="top" align="end" className="w-60 p-3">
            {more === "due" ? <DueForm tasks={tasks} onDone={close} /> : <EstimateForm tasks={tasks} onDone={close} />}
          </PopoverContent>
        </Popover>
      )}

      <Button
        variant="danger-quiet"
        className="max-sm:px-2"
        aria-label={t("bulk.delete")}
        onClick={() => {
          trashTasks(tasks);
          onClear();
        }}
      >
        <Trash2 className="size-3.5" aria-hidden />
        <span className="max-sm:hidden">{t("bulk.delete")}</span>
      </Button>
      <IconButton label={t("bulk.clear")} hint="Esc" onClick={onClear}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
});

/** The value every task shares, or nothing when they differ. */
function shared<T>(tasks: Task[], get: (task: Task) => T | undefined): T | undefined {
  const first = tasks[0] ? get(tasks[0]) : undefined;
  return tasks.every((task) => get(task) === first) ? first : undefined;
}

interface FormProps {
  tasks: Task[];
  onDone: () => void;
}

/** One due date for the whole selection, or none. */
function DueForm({ tasks, onDone }: FormProps) {
  const [day, setDay] = useState(() => shared(tasks, (task) => task.due_on) ?? "");
  const set = (value: string | null) => {
    setDue(tasks, value);
    onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (day) set(day);
      }}
    >
      <label htmlFor="bulk-due" className="text-xs font-medium text-ink-2">
        {t("bulk.due.label", { n: tasks.length })}
      </label>
      <Input id="bulk-due" type="date" autoFocus value={day} onChange={(e) => setDay(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => set(null)}>
          {t("prop.clearDue")}
        </Button>
        <Button type="submit" variant="primary" disabled={!day}>
          {t("bulk.set")}
        </Button>
      </div>
    </form>
  );
}

/** One estimate, in points, for the whole selection, or none. */
function EstimateForm({ tasks, onDone }: FormProps) {
  const [points, setPoints] = useState(() => String(shared(tasks, (task) => task.estimate) ?? ""));
  const n = Number(points);
  const valid = points.trim() !== "" && Number.isInteger(n) && n > 0;
  const set = (value: number | null) => {
    setEstimate(tasks, value);
    onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) set(n);
      }}
    >
      <label htmlFor="bulk-estimate" className="text-xs font-medium text-ink-2">
        {t("bulk.estimate.label", { n: tasks.length })}
      </label>
      <Input
        id="bulk-estimate"
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        autoFocus
        value={points}
        onChange={(e) => setPoints(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => set(null)}>
          {t("bulk.estimate.clear")}
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          {t("bulk.set")}
        </Button>
      </div>
    </form>
  );
}

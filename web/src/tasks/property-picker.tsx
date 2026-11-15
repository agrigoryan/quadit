import { type ReactNode, type RefObject, useState } from "react";
import { CircleSlash, Globe, Layers, RefreshCw, Target } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { useCycles, useEpics, useLabels, useMe, useMembers, useProjects, useStatuses } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Member, Project, Task } from "@/lib/types";
import { formatDay } from "@/lib/time";
import { useListening } from "@/lib/listening";
import { ProjectGlyph } from "@/ui/project-glyph";
import {
  moveToProject,
  OUTSIDE,
  setAssignee,
  setCycle,
  setEpic,
  setMilestone,
  setPriority,
  setStatus,
  setWaitingOn,
  setWaitingOutside,
  toggleLabel,
  waitsOutside,
} from "@/tasks/actions";
import { ChoiceList } from "@/tasks/choice-list";
import { createLabel, createLabelText, useManageLinks } from "@/tasks/manage";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import { Input } from "@/ui/input";
import { ListeningDot } from "@/ui/listening-dot";
import type { PickerItem } from "@/ui/picker";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";

export type TaskProperty =
  "status" | "assignee" | "waiting" | "priority" | "labels" | "epic" | "milestone" | "cycle" | "project";

const NONE = "none";
const noneIcon = <CircleSlash className="size-3.5 text-ink-3" aria-hidden />;

export const PRIORITIES = [0, 1, 2, 3, 4];

/** Says whether something is listening for an agent; nothing for a person. From useListening (lib/listening.ts). */
export type Listening = (member: Member | undefined) => boolean | undefined;

/** People and agents as picker rows, "me" first. With `listening`, each agent shows whether anything waits for its work. */
export function memberItems(members: Member[], meId: string | undefined, listening?: Listening): PickerItem[] {
  return [...members]
    .sort((a, b) => Number(b.user_id === meId) - Number(a.user_id === meId))
    .map((m) => {
      const on = listening?.(m);
      return {
        id: m.user_id,
        label: m.name,
        icon: <Avatar member={m} size="xs" />,
        hint:
          m.kind === "agent" ? (
            <span className="flex items-center gap-1.5">
              {t("common.agent")}
              {on !== undefined && <ListeningDot on={on} />}
            </span>
          ) : undefined,
        keywords: `@${m.handle}`,
      };
    });
}

/** Projects as picker rows: the mark, the name, the key. */
export const projectItems = (projects: Project[]): PickerItem[] =>
  projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, hint: p.key, keywords: p.key }));

/** The rows a picker offers for one property, and what is picked now. */
function useItems(
  kind: TaskProperty,
  tasks: Task[],
  listening?: Listening,
): { items: PickerItem[]; value: string | string[] | undefined } {
  const first = tasks[0];
  const projectId = first?.project_id;
  const statuses = useStatuses(kind === "status" ? projectId : undefined);
  const members = useMembers();
  const me = useMe();
  const labels = useLabels(projectId);
  const epics = useEpics(projectId);
  const cycles = useCycles(projectId);
  const milestones = useStore((s) => s.c.milestones);
  const projects = useProjects();
  const same = <T,>(get: (task: Task) => T) =>
    tasks.every((task) => get(task) === get(first as Task)) ? get(first as Task) : undefined;

  switch (kind) {
    case "status":
      return {
        items: statuses.map((s) => ({
          id: s.id,
          label: s.name,
          icon: <StatusIcon category={s.category} />,
          keywords: tMaybe(`category.${s.category}`),
        })),
        value: same((task) => task.status_id),
      };
    case "assignee":
      return {
        items: [
          { id: NONE, label: t("task.unassigned"), icon: noneIcon },
          ...memberItems(members, me.user_id, listening),
        ],
        value: same((task) => task.assignee_id ?? NONE),
      };
    case "waiting":
      return {
        items: [
          { id: NONE, label: t("prop.nobody"), icon: noneIcon },
          {
            id: OUTSIDE,
            label: t("prop.outside.pick"),
            icon: <Globe className="size-3.5 text-ink-2" aria-hidden />,
            keywords: t("prop.outside.words"),
          },
          ...memberItems(members, me.user_id, listening),
        ],
        value: same((task) => (waitsOutside(task) ? OUTSIDE : (task.waiting_on_id ?? NONE))),
      };
    case "priority":
      return {
        items: PRIORITIES.map((p) => ({
          id: String(p),
          label: t(`priority.${p}` as "priority.0"),
          icon: <PriorityIcon priority={p} title="" />,
          hint: String(p),
        })),
        value: same((task) => String(task.priority)),
      };
    case "labels":
      return {
        items: labels.map((l) => ({
          id: l.id,
          label: l.name,
          icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        })),
        value: labels.filter((l) => tasks.every((task) => task.label_ids?.includes(l.id))).map((l) => l.id),
      };
    case "epic":
      return {
        items: [
          { id: NONE, label: t("task.noEpic"), icon: noneIcon },
          ...epics.map((e) => ({
            id: e.id,
            label: e.name,
            icon: <Layers className="size-3.5 text-ink-2" aria-hidden />,
          })),
        ],
        value: same((task) => task.epic_id ?? NONE),
      };
    case "milestone":
      return {
        items: [
          { id: NONE, label: t("task.noMilestone"), icon: noneIcon },
          ...Object.values(milestones)
            .filter(
              (m) =>
                !m.deleted_at &&
                (!first?.epic_id || m.epic_id === first.epic_id) &&
                epics.some((e) => e.id === m.epic_id),
            )
            .map((m) => ({
              id: m.id,
              label: m.name,
              icon: <Target className="size-3.5 text-ink-2" aria-hidden />,
              hint: m.target_on ? formatDay(m.target_on) : undefined,
            })),
        ],
        value: same((task) => task.milestone_id ?? NONE),
      };
    case "cycle":
      return {
        items: [
          { id: NONE, label: t("task.noCycle"), icon: noneIcon },
          ...cycles.map((c) => ({
            id: c.id,
            label: c.name || t("prop.cycleName", { n: String(c.number) }),
            icon: <RefreshCw className="size-3.5 text-ink-2" aria-hidden />,
            hint: `${formatDay(c.starts_on)} – ${formatDay(c.ends_on)}`,
          })),
        ],
        value: same((task) => task.cycle_id ?? NONE),
      };
    case "project":
      return {
        items: projectItems(projects),
        value: same((task) => task.project_id),
      };
  }
}

function apply(kind: TaskProperty, tasks: Task[], id: string) {
  const value = id === NONE ? null : id;
  switch (kind) {
    case "status":
      return setStatus(tasks, id);
    case "assignee":
      return setAssignee(tasks, value);
    case "waiting":
      return setWaitingOn(tasks, value);
    case "priority":
      return setPriority(tasks, Number(id));
    case "labels":
      return toggleLabel(tasks, id);
    case "epic":
      return setEpic(tasks, value);
    case "milestone":
      return setMilestone(tasks, value);
    case "cycle":
      return setCycle(tasks, value);
    case "project":
      return moveToProject(tasks, id);
  }
}

const titles: Record<TaskProperty, () => string> = {
  status: () => t("prop.set.status"),
  assignee: () => t("prop.set.assignee"),
  waiting: () => t("prop.set.waitingOn"),
  priority: () => t("prop.set.priority"),
  labels: () => t("prop.set.labels"),
  epic: () => t("prop.set.epic"),
  milestone: () => t("prop.set.milestone"),
  cycle: () => t("prop.set.cycle"),
  project: () => t("prop.set.project"),
};

interface Props {
  kind: TaskProperty;
  /** The tasks to change: one, or a whole selection. */
  tasks: Task[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the picker. */
  children?: ReactNode;
  /** Open next to this element instead (for keyboard shortcuts). */
  anchor?: RefObject<Element | null>;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

interface ChoicesProps {
  kind: TaskProperty;
  tasks: Task[];
  close: () => void;
  listening?: Listening;
}

/** Choosing a person or an agent: asks the server which agents have something listening, while the list is open. */
function MemberChoices(props: ChoicesProps) {
  return <Choices {...props} listening={useListening()} />;
}

/** The list inside the popover. It reads the store only while the picker is open. */
function Choices({ kind, tasks, close, listening }: ChoicesProps) {
  const { items, value } = useItems(kind, tasks, listening);
  const projectId = tasks[0]?.project_id;
  const manage = useManageLinks(projectId);
  /** Waiting on an outside event needs a word about which: the list gives way to a note box. */
  const [outside, setOutside] = useState(false);
  if (outside) return <OutsideNote tasks={tasks} onDone={close} />;
  return (
    <ChoiceList
      items={items}
      value={value}
      label={titles[kind]()}
      placeholder={titles[kind]()}
      onPick={(id) => {
        if (kind === "waiting" && id === OUTSIDE) return setOutside(true);
        apply(kind, tasks, id);
        if (kind !== "labels") close();
      }}
      onCreate={kind === "labels" ? (name) => toggleLabel(tasks, createLabel(projectId, name)) : undefined}
      createLabel={createLabelText}
      manage={
        kind === "labels" || kind === "status"
          ? (() => {
              const link = kind === "labels" ? manage.labels : manage.statuses;
              return (
                link && {
                  label: link.label,
                  onSelect: () => {
                    close();
                    link.onSelect();
                  },
                }
              );
            })()
          : undefined
      }
    />
  );
}

/** What the task waits on outside the workspace, in a few words: "the store's review", "the client's reply". */
function OutsideNote({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  const first = tasks[0];
  const [note, setNote] = useState(() => (first && waitsOutside(first) ? (first.waiting_on_note ?? "") : ""));
  return (
    <form
      className="flex w-60 flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setWaitingOutside(tasks, note.trim());
        onDone();
      }}
    >
      <label htmlFor="outside-note" className="text-xs font-medium text-ink-2">
        {t("prop.outside.note")}
      </label>
      <Input
        id="outside-note"
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("prop.outside.placeholder")}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary">
          {t("prop.outside.set")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Changes one property of one or many tasks. Used by rows, the bulk bar, the
 * task panel and the palette. A list draws three of these on every row, so
 * nothing but the trigger exists until one is opened.
 */
export function TaskPropertyPicker({ kind, tasks, open, onOpenChange, children, anchor, align, side }: Props) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      {isOpen && (
        <PopoverContent align={align} side={side} className="p-0">
          {kind === "assignee" || kind === "waiting" ? (
            <MemberChoices kind={kind} tasks={tasks} close={() => setOpen(false)} />
          ) : (
            <Choices kind={kind} tasks={tasks} close={() => setOpen(false)} />
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

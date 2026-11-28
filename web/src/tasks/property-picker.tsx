import { type ReactNode, type RefObject, useState } from "react";
import { CircleSlash } from "lucide-react";
import { isKey, t, tMaybe } from "@/lib/i18n";
import { useConnection, useListening } from "@/data/listening";
import { useRunOutlook } from "@/data/run-outlook";
import { useMembers } from "@/data/selectors";
import type { Member, Project, Task } from "@/types/core";
import type { RunOutlook } from "@/types/dashboard";
import { ProjectGlyph } from "@/ui/project-glyph";
import { useManageLinks } from "@/tasks/manage";
import {
  type Choice,
  ME,
  NONE,
  type PickerListProps,
  type PickerPart,
  type PickerProperty,
  type RowsPicker,
} from "@/tasks/properties/property";
import { Avatar } from "@/ui/avatar";
import { ListeningDot } from "@/ui/listening-dot";
import { type PickerItem, PickerList } from "@/ui/picker";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** The row that stands for "nothing set" at the top of a list. */
export const noneItem = (label: string): PickerItem => ({
  id: NONE,
  label,
  icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden />,
});

/** The choice of "nothing set" at the top of a page of the palette. */
export const noneChoice = (label: string, checked: boolean, apply: () => void): Choice => ({
  id: NONE,
  label,
  icon: <CircleSlash className="text-ink-3" />,
  checked,
  apply,
});

/**
 * Whether something listens for a member's work in the tasks' project
 * (data/listening.ts); no answer, so no mark, for tasks of several
 * projects, where no one answer is true.
 */
export function useListeningFor(tasks: Task[]): Listening {
  const first = tasks[0]?.project_id;
  const one = first && tasks.every((task) => task.project_id === first) ? first : undefined;
  const listening = useListening(one);
  return one ? listening : () => undefined;
}

/** Says whether something is listening for an agent; nothing for a person. From useListening (data/listening.ts). */
export type Listening = (member: Member | undefined) => boolean | undefined;

/** Says in a few words what picking a member would do; nothing when there is nothing to say. */
export type Outlook = (member: Member) => string | undefined;

/** The few words of an outlook for assigning a task; none when Quadit would not start the agent for it, or a chat holds it. */
function assignWords(o: RunOutlook, members: Member[]): string | undefined {
  if (o.outcome === "none" || o.outcome === "in_chat") return undefined;
  const key = `assign.run.${o.outcome === "will_not_start" ? o.reason : o.outcome}`;
  if (!isKey(key)) return undefined;
  const owner = members.find((m) => `@${m.handle}` === o.owner);
  return t(key, {
    machine: o.machine,
    owner: owner?.name ?? o.owner,
    project: o.project,
    program: tMaybe(`run.program.${o.program}`, o.program),
  });
}

/**
 * What assigning one task would do, for each agent a computer runs (the
 * run outlook), asked while the picker is open. Nothing for the agent that
 * has the task already (assigning it again makes no item), and nothing for
 * several tasks at once.
 */
export function useAssignOutlook(tasks: Task[]): Outlook {
  const one = tasks.length === 1 ? tasks[0] : undefined;
  const members = useMembers();
  const connection = useConnection();
  const other = (m: Member) => m.user_id !== one?.assignee_id;
  const run = one ? members.filter((m) => other(m) && connection(m, one.project_id)?.runner) : [];
  const { outlooks } = useRunOutlook(
    one?.key,
    run.map((m) => m.handle),
    "assign",
  );
  return (member) => {
    const o = outlooks[`@${member.handle}`];
    return o && other(member) ? assignWords(o, members) : undefined;
  };
}

/**
 * People and agents as picker rows, "me" first. With `listening`, each
 * agent shows whether anything waits for its work; with `outlook`, what
 * picking it would do.
 */
export function memberItems(
  members: Member[],
  meId: string | undefined,
  listening?: Listening,
  outlook?: Outlook,
): PickerItem[] {
  return [...members]
    .sort((a, b) => Number(b.user_id === meId) - Number(a.user_id === meId))
    .map((m) => {
      const on = listening?.(m);
      return {
        id: m.user_id,
        label: m.name,
        detail: outlook?.(m),
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

/**
 * People and agents as a filter's rows, with me first as "Me": picked, the
 * filter holds ME, so the page's address and a saved view say "me" and a
 * shared view shows each person their own. A view that names me by handle,
 * as views saved before did, keeps a row of my own name while it does.
 */
export function memberFilterItems(members: Member[], meId: string, picked: string[]): PickerItem[] {
  const items = memberItems(members, meId);
  const mine = items.find((item) => item.id === meId);
  const others = items.filter((item) => item.id !== meId || picked.includes(meId));
  if (!mine) return others;
  return [{ ...mine, id: ME, label: t("filter.me"), keywords: `${mine.label} ${mine.keywords ?? ""}` }, ...others];
}

/** Projects as picker rows: the mark, the name, the key. */
export const projectItems = (projects: Project[]): PickerItem[] =>
  projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, hint: p.key, keywords: p.key }));

/** The list inside the popover. It reads the store only while the picker is open. */
function Choices({
  property,
  picker,
  tasks,
  close,
}: { property: PickerProperty; picker: PickerPart & RowsPicker } & PickerListProps) {
  const { make, manage } = property;
  const { items, value } = picker.useItems(tasks);
  const projectId = tasks[0]?.project_id;
  const links = useManageLinks(projectId);
  const link = manage && links[manage];
  return (
    <PickerList
      items={items}
      value={value}
      label={picker.title()}
      placeholder={picker.title()}
      onPick={(id) => {
        picker.pick(tasks, id);
        if (!Array.isArray(value)) close();
      }}
      onCreate={make && ((name) => picker.pick(tasks, make.run(projectId, name)))}
      createLabel={make?.label}
      manage={
        link
          ? {
              label: link.label,
              onSelect: () => {
                close();
                link.onSelect();
              },
            }
          : undefined
      }
    />
  );
}

interface Props {
  property: PickerProperty;
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
  /** Where the focus goes when the picker closes, in place of its trigger: for one that has none, or loses it. */
  onCloseAutoFocus?: (e: Event) => void;
}

/**
 * Changes one property of one or many tasks, by picking from the list its
 * description gives (tasks/properties). Used by rows, the bulk bar and the
 * task panel. A list draws three of these on every row, so nothing but the
 * trigger exists until one is opened.
 */
export function TaskPropertyPicker({
  property,
  tasks,
  open,
  onOpenChange,
  children,
  anchor,
  align,
  side,
  onCloseAutoFocus,
}: Props) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const { picker } = property;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      {isOpen && (
        <PopoverContent
          align={align}
          side={side}
          aria-label={property.picker.title()}
          onCloseAutoFocus={onCloseAutoFocus}
          className="p-0"
        >
          {/* Keyed by the property: each kind's list reads different tables. */}
          {picker.List ? (
            <picker.List key={property.name} tasks={tasks} close={() => setOpen(false)} />
          ) : (
            <Choices
              key={property.name}
              property={property}
              picker={picker}
              tasks={tasks}
              close={() => setOpen(false)}
            />
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

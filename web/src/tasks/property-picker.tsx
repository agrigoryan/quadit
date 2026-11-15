import { type ReactNode, type RefObject, useState } from "react";
import { CircleSlash } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Member, Project, Task } from "@/lib/types";
import { ProjectGlyph } from "@/ui/project-glyph";
import { useManageLinks } from "@/tasks/manage";
import { NONE, type PickerListProps, type PickerProperty } from "@/tasks/properties/property";
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

/** The list inside the popover. It reads the store only while the picker is open. */
function Choices({ property, tasks, close }: { property: PickerProperty } & PickerListProps) {
  const { picker, make, manage } = property;
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
}

/**
 * Changes one property of one or many tasks, by picking from the list its
 * description gives (tasks/properties). Used by rows, the bulk bar and the
 * task panel. A list draws three of these on every row, so nothing but the
 * trigger exists until one is opened.
 */
export function TaskPropertyPicker({ property, tasks, open, onOpenChange, children, anchor, align, side }: Props) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const List = property.picker.List;
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      {children && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      {isOpen && (
        <PopoverContent align={align} side={side} aria-label={property.picker.title()} className="p-0">
          {/* Keyed by the property: each kind's list reads different tables. */}
          {List ? (
            <List key={property.name} tasks={tasks} close={() => setOpen(false)} />
          ) : (
            <Choices key={property.name} property={property} tasks={tasks} close={() => setOpen(false)} />
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

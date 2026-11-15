// A searchable list of tasks in a popover: used to pick a parent and the
// other side of a relation. Search matches the key and the title.

import { type ReactNode, useMemo } from "react";
import { useLookup, useRows } from "@/lib/selectors";
import type { Task } from "@/types/core";
import { StatusIcon } from "@/ui/icons";
import { Picker, type PickerItem } from "@/ui/picker";

interface Props {
  /** Which tasks to offer. Tasks in the trash or the archive are never offered. */
  filter: (task: Task) => boolean;
  value?: string | null;
  onPick: (taskId: string) => void;
  label: string;
  /** Rows shown above the tasks, such as "No parent". */
  extra?: PickerItem[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function TaskPicker({ filter, value, onPick, label, extra, open, onOpenChange, children }: Props) {
  const tasks = useRows("tasks");
  const statuses = useLookup("statuses");
  const items = useMemo<PickerItem[]>(() => {
    const rows = tasks
      .filter(filter)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((tk) => {
        const category = statuses[tk.status_id]?.category;
        return {
          id: tk.id,
          label: tk.title,
          icon: category ? <StatusIcon category={category} /> : undefined,
          hint: <span className="tnum">{tk.key}</span>,
          keywords: tk.key,
        };
      });
    return [...(extra ?? []), ...rows];
  }, [tasks, statuses, filter, extra]);

  return (
    <Picker
      items={items}
      value={value}
      onPick={onPick}
      label={label}
      placeholder={label}
      open={open}
      onOpenChange={onOpenChange}
    >
      {children}
    </Picker>
  );
}

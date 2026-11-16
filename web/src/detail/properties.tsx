// Everything a task is filed under, as one dense block of label and value
// rows: two columns of rows on a wide panel, one on a phone and at the side
// of the task's own page. Each property draws its own row (tasks/properties),
// where the task has it; the keys of those that have one (S, A, P, L, Shift
// with P, M, C, E or D) open their pickers or put the caret in their box.

import { useRef, useState } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { useHotkeys } from "@/hooks/hotkeys";
import { useNow } from "@/data/live";
import { t } from "@/lib/i18n";
import { useMember, useRowEvenIfGone } from "@/data/selectors";
import type { Task } from "@/types/core";
import { nameOf } from "@/detail/data";
import { KEYED, PROPERTIES, type PropertyName } from "@/tasks/properties";
import { applies } from "@/tasks/properties/property";
import { Avatar } from "@/ui/avatar";

/**
 * A typed value's box, given the caret by its key: what is in it is chosen,
 * so what is typed replaces it, and a day's box opens its calendar too.
 */
function takeCaret(box: HTMLElement) {
  box.focus();
  if (!(box instanceof HTMLInputElement)) return;
  if (box.type === "date") box.showPicker?.();
  else box.select();
}

interface Props {
  task: Task;
  /** At the side of the task's page: one column of rows where the page is wide enough to have a side. */
  side?: boolean;
}

export function Properties({ task, side }: Props) {
  const can = useCan();
  const holder = useMember(task.lease_holder_id);
  const readOnly = !can.editTask(task);
  const now = useNow();
  const held = holder && (task.lease_until ?? 0) > now;
  // An archived project is still where the task lives, and still says which properties it has.
  const project = useRowEvenIfGone("projects", task.project_id);

  // Which row's picker is open, and the controls a key opens a picker next to or puts the caret in.
  const [opened, setOpened] = useState<PropertyName | null>(null);
  const controls = useRef<Partial<Record<PropertyName, HTMLElement | null>>>({});

  useHotkeys(
    Object.fromEntries(
      KEYED.map((property) => [
        property.key.key,
        (e: KeyboardEvent) => {
          const control = controls.current[property.name];
          if (readOnly || !applies(property, task, project) || !control) return;
          e.preventDefault(); // or the letter lands in the box that takes the caret
          control.scrollIntoView({ block: "nearest" });
          if (property.picker) setOpened(property.name);
          else takeCaret(control);
        },
      ]),
    ),
    { layer: "panel" },
  );

  return (
    <section
      aria-label={t("detail.properties")}
      className={cx(
        "border-t border-line px-4 py-2.5 md:px-6",
        side && "lg:sticky lg:top-0 lg:border-t-0 lg:px-5 lg:pt-6",
      )}
    >
      <dl
        className={cx(
          "grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2",
          side && "lg:grid-cols-1 lg:gap-y-1 lg:[&>*]:col-span-1",
        )}
      >
        {PROPERTIES.map(
          (property) =>
            property.Panel &&
            applies(property, task, project) && (
              <property.Panel
                key={property.name}
                task={task}
                side={side}
                readOnly={readOnly}
                picker={{
                  open: opened === property.name,
                  onOpenChange: (open) => setOpened(open ? property.name : null),
                }}
                takeControl={(el) => {
                  controls.current[property.name] = el;
                }}
              />
            ),
        )}
      </dl>

      {held && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-2">
          <Avatar member={holder} size="xs" />
          {t("task.heldBy", { name: nameOf(holder) })}
        </p>
      )}
    </section>
  );
}

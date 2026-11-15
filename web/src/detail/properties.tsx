// Everything a task is filed under, as one dense block of label and value
// rows: two columns of rows on a wide panel, one on a phone and at the side
// of the task's own page. Each property draws its own row (tasks/properties);
// the keys of those that have one (S, A, P, L) open their pickers.

import { useRef, useState } from "react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { useHotkeys } from "@/hooks/hotkeys";
import { useNow } from "@/data/live";
import { t } from "@/lib/i18n";
import { useMember } from "@/data/selectors";
import type { Task } from "@/types/core";
import { nameOf } from "@/detail/data";
import { KEYED, PROPERTIES, type PropertyName } from "@/tasks/properties";
import { Avatar } from "@/ui/avatar";

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

  // Which row's picker is open, and the buttons a key's picker opens next to.
  const [opened, setOpened] = useState<PropertyName | null>(null);
  const buttons = useRef<Partial<Record<PropertyName, HTMLButtonElement | null>>>({});

  useHotkeys(
    Object.fromEntries(
      KEYED.map(({ name, picker }) => [
        picker.hotkey?.key,
        (e: KeyboardEvent) => {
          if (readOnly) return;
          e.preventDefault();
          buttons.current[name]?.scrollIntoView({ block: "nearest" });
          setOpened(name);
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
          ({ name, Panel }) =>
            Panel && (
              <Panel
                key={name}
                task={task}
                side={side}
                readOnly={readOnly}
                picker={{ open: opened === name, onOpenChange: (open) => setOpened(open ? name : null) }}
                takeButton={(el) => {
                  buttons.current[name] = el;
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

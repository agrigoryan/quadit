import { Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Task } from "@/types/core";
import { Group, Item, Note } from "@/palette/palette-rows";
import { matches } from "@/palette/palette-search";
import type { PALETTE } from "@/tasks/properties";

interface Props {
  property: (typeof PALETTE)[number];
  task: Task;
  query: string;
  /** Runs the choice and closes the palette. */
  run: (action: () => void) => void;
}

/** The palette's second page: the values one property of the open task can take (tasks/properties). */
export function ChoicesPage({ property, task, query, run }: Props) {
  const { name, palette, make, picker } = property;
  const choices = palette.useChoices(task);
  const q = query.trim();
  const shown = q ? choices.filter((c) => matches(q, `${c.label} ${c.detail ?? ""} ${c.words ?? ""}`)) : choices;

  // A value that does not exist yet (a label) can be made here and put on the task in one go.
  const canCreate = !!make && !!picker && q !== "" && !choices.some((c) => c.label.toLowerCase() === q.toLowerCase());

  if (choices.length === 0 && palette.empty && !canCreate) return <Note>{palette.empty()}</Note>;
  if (shown.length === 0 && !canCreate) return <Note>{t("common.noMatches")}</Note>;

  return (
    <Group>
      {shown.map((c) => (
        <Item
          key={c.id}
          value={`${name}:${c.id}`}
          icon={c.icon}
          detail={
            c.mark ? (
              <>
                {c.detail}
                {c.mark}
              </>
            ) : (
              c.detail
            )
          }
          checked={c.checked}
          onSelect={() => run(c.apply)}
        >
          {c.label}
        </Item>
      ))}
      {canCreate && make && picker && (
        <Item
          value={`${name}:create`}
          icon={<Plus />}
          onSelect={() => run(() => picker.pick([task], make.run(task.project_id, q)))}
        >
          {make.label(q)}
        </Item>
      )}
    </Group>
  );
}

import { Fragment, memo, useRef, useState } from "react";
import { Ellipsis, Trash2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCan } from "@/lib/access";
import { useRowEvenIfGone } from "@/lib/selectors";
import type { Task } from "@/types/core";
import { trashTasks } from "@/tasks/actions";
import { BULK } from "@/tasks/properties";
import { hasPicker } from "@/tasks/properties/property";
import { TaskPropertyPicker } from "@/tasks/property-picker";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";

interface Props {
  tasks: Task[];
  onClear: () => void;
}

type Bulk = (typeof BULK)[number];

/**
 * Floats above the list while tasks are selected: change them all at once,
 * as one batch. What it offers, and where, each property says
 * (tasks/properties).
 */
export const BulkBar = memo(function BulkBar({ tasks, onClear }: Props) {
  /** What a More menu entry opened next to the menu's button. */
  const [more, setMore] = useState<Bulk | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** Set when a menu entry opens something of its own, so the closing menu does not take the focus back. */
  const handingOver = useRef(false);
  // The tasks may be in an archived project, whose page still lists them.
  const project = useRowEvenIfGone("projects", tasks[0]?.project_id);
  const can = useCan();
  if (tasks.length === 0) return null;
  // Every action here changes the tasks: for a selection the viewer may not change, they are all disabled.
  const readOnly = !tasks.every((task) => can.editTask(task));
  const offered = BULK.filter((p) => p.bulk.offered?.(project) ?? true);
  const menu = offered.filter((p) => p.bulk.place !== "bar");

  const open = (what: Bulk) => () => {
    handingOver.current = true;
    setMore(what);
  };
  // What the menu opened has no trigger of its own; the focus goes back to the menu's button.
  const close = () => {
    setMore(null);
    moreButton.current?.focus();
  };
  const Form = more?.bulk.Form;

  return (
    <div
      role="toolbar"
      aria-label={t("bulk.selected", { n: tasks.length })}
      className="absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 overflow-x-auto rounded-lg bg-surface p-1.5 pl-3 shadow-pop no-scrollbar animate-pop"
    >
      <span className="mr-1 shrink-0 text-sm font-medium tnum">{t("bulk.selected", { n: tasks.length })}</span>
      {offered.map(
        (p) =>
          p.bulk.place === "bar" &&
          hasPicker(p) && (
            <TaskPropertyPicker key={p.name} property={p} tasks={tasks} side="top">
              <Button size="md" className="max-sm:px-2" disabled={readOnly} aria-label={p.title()}>
                {p.bulk.icon}
                <span className="max-sm:hidden">{p.title()}</span>
              </Button>
            </TaskPropertyPicker>
          ),
      )}

      <Menu>
        <MenuTrigger asChild>
          <Button ref={moreButton} size="md" className="max-sm:px-2" disabled={readOnly} aria-label={t("bulk.more")}>
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
          {menu.map((p, i) => (
            <Fragment key={p.name}>
              {p.bulk.place === "move" && menu[i - 1]?.bulk.place !== "move" && <MenuSeparator />}
              <MenuItem icon={p.bulk.icon} onSelect={open(p)}>
                {p.bulk.label?.()}
              </MenuItem>
            </Fragment>
          ))}
        </MenuContent>
      </Menu>
      {more && hasPicker(more) && (
        <TaskPropertyPicker
          property={more}
          tasks={tasks}
          open
          onOpenChange={(next) => !next && close()}
          anchor={moreButton}
          side="top"
          align="end"
        />
      )}
      {more && Form && (
        <Popover open onOpenChange={(next) => !next && close()}>
          <PopoverAnchor virtualRef={moreButton} />
          <PopoverContent side="top" align="end" aria-label={more.bulk.label?.()} className="w-60 p-3">
            <Form tasks={tasks} onDone={close} />
          </PopoverContent>
        </Popover>
      )}

      <Button
        variant="danger-quiet"
        className="max-sm:px-2"
        disabled={readOnly}
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

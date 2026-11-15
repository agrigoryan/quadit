import { type FormEvent, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MoreHorizontal, Star, Trash2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/data/mutate";
import { rankBetween } from "@/lib/rank";
import { useStatuses } from "@/data/selectors";
import { useTasksOutOfTrash } from "@/settings/projects/data";
import { CATEGORIES, type Category, type Project, type Status } from "@/types/core";
import { ColorButton } from "@/settings/projects/color-button";
import { InlineName } from "@/settings/projects/inline-name";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { FormAlert, FormField, NativeSelect, useFieldErrors, useSubmit } from "@/ui/form";
import { Rows } from "@/ui/page-layout";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

const categoryChoices = () => CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) }));

const patch = (status: Status, fields: Partial<Status>) =>
  send({ type: "status.update", args: { id: status.id, ...fields } }, (tx) => tx.patch("statuses", status.id, fields));

interface RowProps {
  status: Status;
  count: number;
  admin: boolean;
  onDelete: () => void;
  onDefault: () => void;
}

function StatusRow({ status, count, admin, onDelete, onDefault }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
    disabled: !admin,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        "flex h-11 items-center gap-1.5 bg-surface pr-2 pl-1 first:rounded-t-lg last:rounded-b-lg",
        isDragging && "relative z-10 shadow-pop",
      )}
    >
      {admin ? (
        <button
          type="button"
          aria-label={t("statuses.drag", { name: status.name })}
          className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink-2 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <StatusIcon category={status.category} />
      <ColorButton
        value={status.color}
        onChange={(color) => patch(status, { color })}
        label={t("statuses.color", { name: status.name })}
        disabled={!admin}
      />
      <InlineName
        value={status.name}
        onSave={(name) => patch(status, { name })}
        label={t("statuses.name")}
        disabled={!admin}
      />
      {status.is_default && (
        <Badge tone="accent" title={t("statuses.defaultHint")}>
          {t("statuses.default")}
        </Badge>
      )}
      <span className="w-14 shrink-0 text-right text-xs text-ink-3 tnum max-sm:hidden">
        {t("statuses.count", { n: count })}
      </span>
      {admin ? (
        <NativeSelect
          aria-label={t("statuses.category")}
          value={status.category}
          onChange={(category) => patch(status, { category: category as Category })}
          options={categoryChoices()}
          className="w-30 shrink-0 max-sm:w-26"
        />
      ) : (
        <span className="w-24 shrink-0 text-xs text-ink-2">{t(`category.${status.category}`)}</span>
      )}
      {admin && (
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("statuses.menu", { name: status.name })}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Star />} disabled={!!status.is_default} onSelect={onDefault}>
              {t("statuses.makeDefault")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
              {t("s.delete")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

/** A project's statuses: rename, recolour, set what each means, reorder by dragging, add and delete. */
export function ProjectStatuses({ project, admin }: { project: Project; admin: boolean }) {
  const statuses = useStatuses(project.id);
  const tasks = useTasksOutOfTrash();
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const task of tasks) if (task.project_id === project.id) out[task.status_id] = (out[task.status_id] ?? 0) + 1;
    return out;
  }, [tasks, project.id]);

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = statuses.findIndex((s) => s.id === e.active.id);
    const to = statuses.findIndex((s) => s.id === e.over?.id);
    const moved = statuses[from];
    if (!moved || to < 0) return;
    const next = arrayMove(statuses, from, to);
    patch(moved, { rank: rankBetween(next[to - 1]?.rank, next[to + 1]?.rank) });
  }

  function makeDefault(status: Status) {
    const old = statuses.find((s) => s.is_default);
    send({ type: "status.update", args: { id: status.id, is_default: true } }, (tx) => {
      if (old) tx.patch("statuses", old.id, { is_default: null });
      tx.patch("statuses", status.id, { is_default: true });
    });
  }

  const others = statuses.filter((s) => s.id !== deleting?.id);
  const needsMove = !!deleting && ((counts[deleting.id] ?? 0) > 0 || !!deleting.is_default);

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-ink-2">{t("statuses.lead")}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={statuses.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <Rows className="!overflow-visible">
            {statuses.map((s) => (
              <StatusRow
                key={s.id}
                status={s}
                count={counts[s.id] ?? 0}
                admin={admin}
                onDefault={() => makeDefault(s)}
                onDelete={() => {
                  setMoveTo(
                    others.find((o) => o.id !== s.id && o.category === s.category)?.id ??
                      statuses.find((o) => o.id !== s.id)?.id ??
                      "",
                  );
                  setDeleting(s);
                }}
              />
            ))}
          </Rows>
        </SortableContext>
      </DndContext>
      {admin && <AddStatus project={project} last={statuses[statuses.length - 1]?.rank} />}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("statuses.delete.title", { name: deleting?.name ?? "" })}
        body={needsMove ? t("statuses.delete.body") : t("statuses.delete.empty")}
        confirm={t("s.delete")}
        onConfirm={() =>
          deleting
            ? mutate(
                { type: "status.delete", args: { id: deleting.id, ...(needsMove ? { move_to: moveTo } : {}) } },
                undefined,
                { quiet: true },
              )
            : undefined
        }
      >
        {needsMove && (
          <FormField
            label={`${t("statuses.moveTo")} (${t("statuses.count", { n: counts[deleting?.id ?? ""] ?? 0 })})`}
            htmlFor="status-move-to"
          >
            <NativeSelect
              id="status-move-to"
              value={moveTo}
              onChange={setMoveTo}
              options={others.map((s) => ({ value: s.id, label: s.name }))}
            />
          </FormField>
        )}
      </ConfirmDialog>
    </div>
  );
}

function AddStatus({ project, last }: { project: Project; last: string | undefined }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("started");
  const errors = useFieldErrors(["name", "category"]);
  const { busy, run } = useSubmit(errors);

  async function add(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) return errors.set("name", t("s.required"));
    await run(async () => {
      await mutate(
        {
          type: "status.create",
          args: { id: newId(), project: project.id, name: name.trim(), category, rank: rankBetween(last, undefined) },
        },
        undefined,
        { quiet: true },
      );
      setName("");
    });
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <Input
          aria-label={t("statuses.name")}
          placeholder={t("statuses.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1"
          aria-invalid={!!errors.fields.name}
        />
        <NativeSelect
          aria-label={t("statuses.category")}
          value={category}
          onChange={(v) => setCategory(v as Category)}
          options={categoryChoices()}
          className="w-32 shrink-0"
        />
        <Button type="submit" disabled={busy} className="h-8">
          {t("statuses.add")}
        </Button>
      </div>
      <FormAlert>{errors.fields.name || errors.fields.category || errors.form}</FormAlert>
    </form>
  );
}

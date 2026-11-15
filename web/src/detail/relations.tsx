// How this task stands to others: what it blocks, what blocks it, what it
// relates to or repeats. The server keeps one row per pair, so each row is
// read from this task's side.

import { useCallback, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/data/mutate";
import { getRows, useLookupEvenIfGone, useRow } from "@/data/selectors";
import { getState } from "@/data/store";
import { toast } from "@/lib/toast";
import type { Relation, Task } from "@/types/core";
import { type Side, sideOf, useEnsureTasks } from "@/detail/data";
import { rowAction } from "@/detail/row-action";
import { Section } from "@/detail/section";
import { TaskPicker } from "@/detail/task-picker";
import { useTaskLink } from "@/nav/task-link";
import { Button, IconButton } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";
import { Select } from "@/ui/picker";

const SIDES: Side[] = ["blocks", "blockedBy", "relates", "duplicates", "duplicatedBy"];

type AddType = "blocks" | "blocked_by" | "relates" | "duplicates";
const ADD_TYPES: { id: AddType; side: Side }[] = [
  { id: "blocks", side: "blocks" },
  { id: "blocked_by", side: "blockedBy" },
  { id: "relates", side: "relates" },
  { id: "duplicates", side: "duplicates" },
];

/** The row the server will store, so the optimistic copy matches it. */
function storedRow(taskId: string, type: AddType, otherId: string) {
  if (type === "blocked_by") return { task_id: otherId, related_task_id: taskId, type: "blocks" as const };
  if (type === "relates") {
    const [a, b] = otherId < taskId ? [otherId, taskId] : [taskId, otherId];
    return { task_id: a, related_task_id: b, type: "relates" as const };
  }
  return { task_id: taskId, related_task_id: otherId, type };
}

function addRelation(task: Task, type: AddType, otherId: string) {
  const { me } = getState();
  const row = storedRow(task.id, type, otherId);
  const exists = getRows("relations").some(
    (r) => r.task_id === row.task_id && r.related_task_id === row.related_task_id && r.type === row.type,
  );
  if (exists) {
    toast.info(t("detail.relations.exists"));
    return;
  }
  const id = newId();
  send({ type: "relation.add", args: { id, task: task.id, type, other: otherId } }, (tx) =>
    tx.insert("relations", { id, ...row, created_by: me?.user_id, created_at: Date.now() }),
  );
}

function removeRelation(id: string) {
  send({ type: "relation.remove", args: { id } }, (tx) => tx.remove("relations", id));
}

function RelationRow({ relation, other, readOnly }: { relation: Relation; other: Task; readOnly: boolean }) {
  const status = useRow("statuses", other.status_id);
  const link = useTaskLink(other);
  return (
    <li className="group relative -mx-1.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover max-md:h-10">
      <span className="flex size-6 shrink-0 items-center justify-center">
        {status && <StatusIcon category={status.category} title={status.name} />}
      </span>
      <span className="shrink-0 text-xs text-ink-3 tnum">{other.key}</span>
      <Link
        {...link}
        className="min-w-0 flex-1 truncate py-1.5 outline-none after:absolute after:inset-0 after:content-['']"
      >
        {other.title}
      </Link>
      {!readOnly && (
        <IconButton
          label={t("detail.relations.remove", { key: other.key })}
          size="sm"
          className={cx("relative z-[1]", rowAction)}
          onClick={() => removeRelation(relation.id)}
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </li>
  );
}

function AddRelation({ task, onDone }: { task: Task; onDone: () => void }) {
  const [type, setType] = useState<AddType>("blocks");
  const filter = useCallback((tk: Task) => tk.id !== task.id, [task.id]);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Select
        label={t("detail.relations.type")}
        value={type}
        items={ADD_TYPES.map((a) => ({ id: a.id, label: t(`detail.relations.${a.side}`) }))}
        onPick={(id) => setType(id as AddType)}
        buttonProps={{ className: "max-md:h-9" }}
      />
      <TaskPicker
        filter={filter}
        label={t("detail.relations.pick")}
        onPick={(otherId) => {
          addRelation(task, type, otherId);
          onDone();
        }}
      >
        <Button className="max-md:h-9">{t("detail.relations.pick")}</Button>
      </TaskPicker>
      <Button variant="ghost" className="max-md:h-9" onClick={onDone}>
        {t("common.cancel")}
      </Button>
    </div>
  );
}

interface Props {
  task: Task;
  relations: Relation[];
  /** Start with the add form open (the section was opened to add the first one). */
  startAdding?: boolean;
  /** Called when the add form closes with nothing in the section. */
  onEmptyClose?: () => void;
}

export function Relations({ task, relations, startAdding, onEmptyClose }: Props) {
  // An archived task still stands in a relation; one in the trash does not.
  const tasks = useLookupEvenIfGone("tasks");
  const [adding, setAdding] = useState(!!startAdding);
  const can = useCan();
  const readOnly = !can.editTask(task);
  // The task at the other end may not be in the local copy yet; the relation is shown once it is.
  useEnsureTasks(useMemo(() => relations.map((r) => sideOf(r, task.id).otherId), [relations, task.id]));

  const groups = SIDES.map((side) => ({
    side,
    rows: relations.flatMap((relation) => {
      const seen = sideOf(relation, task.id);
      const other = tasks[seen.otherId];
      return seen.side === side && other && !other.deleted_at ? [{ relation, other }] : [];
    }),
  })).filter((g) => g.rows.length > 0);

  function closeForm() {
    setAdding(false);
    if (groups.length === 0) onEmptyClose?.();
  }

  return (
    <Section
      title={t("detail.relations")}
      action={
        !readOnly &&
        !adding && (
          <IconButton
            label={t("detail.relations.add")}
            size="sm"
            className="max-md:size-9"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
          </IconButton>
        )
      }
    >
      {groups.map((group) => (
        <div key={group.side} className="mt-0.5 sm:flex sm:gap-2">
          <p className="w-[5.5rem] shrink-0 py-1.5 text-xs text-ink-3 max-sm:pt-1 max-sm:pb-0">
            {t(`detail.relations.${group.side}`)}
          </p>
          <ul className="min-w-0 flex-1">
            {group.rows.map(({ relation, other }) => (
              <RelationRow key={relation.id} relation={relation} other={other} readOnly={readOnly} />
            ))}
          </ul>
        </div>
      ))}
      {adding && <AddRelation task={task} onDone={closeForm} />}
    </Section>
  );
}

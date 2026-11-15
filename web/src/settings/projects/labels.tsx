import type { Changes } from "@/lib/changes.gen";
import { type FormEvent, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { useCan } from "@/lib/access";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/lib/mutate";
import { useRows } from "@/lib/selectors";
import type { Label, Project } from "@/lib/types";
import { useTasksOutOfTrash } from "@/settings/projects/data";
import { ColorButton } from "@/settings/projects/color-button";
import { InlineName } from "@/settings/projects/inline-name";
import { SWATCHES } from "@/lib/swatches";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { FormAlert, NativeSelect, useFieldErrors, useSubmit } from "@/ui/form";
import { EmptyRow, Rows, Section } from "@/ui/page-layout";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";

const patch = (label: Label, fields: Partial<Label>) =>
  send({ type: "label.update", args: { id: label.id, ...fields } }, (tx) => tx.patch("labels", label.id, fields));

function LabelRows({
  labels,
  counts,
  admin,
  onDelete,
}: {
  labels: Label[];
  counts: Record<string, number>;
  /** Renaming, recolouring and deleting a label is an admin's call (label.update, label.delete). */
  admin: boolean;
  onDelete: (label: Label) => void;
}) {
  return (
    <Rows>
      {labels.map((label) => (
        <div key={label.id} className="flex h-10 items-center gap-1.5 pr-1.5 pl-2">
          <ColorButton
            value={label.color}
            onChange={(color) => patch(label, { color })}
            label={t("labels.color", { name: label.name })}
            disabled={!admin}
          />
          <InlineName
            value={label.name}
            onSave={(name) => patch(label, { name })}
            label={t("labels.name")}
            disabled={!admin}
          />
          <span className="shrink-0 text-xs text-ink-3 tnum">{t("statuses.count", { n: counts[label.id] ?? 0 })}</span>
          {admin && (
            <IconButton label={`${t("s.delete")}: ${label.name}`} onClick={() => onDelete(label)}>
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </div>
      ))}
    </Rows>
  );
}

/** The labels tasks in this project can carry: its own, and the workspace's. */
export function ProjectLabels({ project }: { project: Project }) {
  const all = useRows("labels");
  const tasks = useTasksOutOfTrash();
  const can = useCan();
  const [deleting, setDeleting] = useState<Label | null>(null);

  const { own, shared, counts } = useMemo(() => {
    const live = [...all].sort((a, b) => a.name.localeCompare(b.name));
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      for (const id of task.label_ids ?? []) counts[id] = (counts[id] ?? 0) + 1;
    }
    return { own: live.filter((l) => l.project_id === project.id), shared: live.filter((l) => !l.project_id), counts };
  }, [all, tasks, project.id]);

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-sm text-ink-2">{t("labels.lead")}</p>
      <Section title={t("labels.project")}>
        {own.length === 0 ? (
          <EmptyRow>{t("labels.none")}</EmptyRow>
        ) : (
          <LabelRows labels={own} counts={counts} admin={can.administer} onDelete={setDeleting} />
        )}
      </Section>
      {shared.length > 0 && (
        <Section title={t("labels.workspace")}>
          <LabelRows labels={shared} counts={counts} admin={can.administer} onDelete={setDeleting} />
        </Section>
      )}
      {can.write && <AddLabel project={project} used={own.length + shared.length} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("labels.delete.title", { name: deleting?.name ?? "" })}
        body={t("labels.delete.body")}
        confirm={t("s.delete")}
        onConfirm={() => mutate({ type: "label.delete", args: { id: deleting?.id } }, undefined, { quiet: true })}
      />
    </div>
  );
}

function AddLabel({ project, used }: { project: Project; used: number }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"project" | "workspace">("project");
  const errors = useFieldErrors(["name"]);
  const { busy, run } = useSubmit(errors);

  async function add(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) return errors.set("name", t("s.required"));
    await run(async () => {
      const args: Changes["label.create"] = {
        id: newId(),
        name: name.trim(),
        color: SWATCHES[(used + 2) % SWATCHES.length],
      };
      if (scope === "project") args.project = project.id;
      await mutate({ type: "label.create", args }, undefined, { quiet: true });
      setName("");
    });
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <Input
          aria-label={t("labels.name")}
          placeholder={t("labels.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1"
        />
        <NativeSelect
          aria-label={t("labels.scope")}
          value={scope}
          onChange={(v) => setScope(v as "project" | "workspace")}
          className="w-36 shrink-0"
          options={[
            { value: "project", label: t("labels.project") },
            { value: "workspace", label: t("labels.workspace") },
          ]}
        />
        <Button type="submit" disabled={busy} className="h-8">
          {t("labels.add")}
        </Button>
      </div>
      <FormAlert>{errors.fields.name || errors.form}</FormAlert>
    </form>
  );
}

import { useMemo, useState } from "react";
import { HelpCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { t, tMaybe } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { useCollection } from "@/lib/selectors";
import type { Project, Template } from "@/lib/types";
import { TemplateDialog } from "@/settings/projects/template-dialog";
import { ConfirmDialog } from "@/ui/settings-dialogs";
import { EmptyRow, Row, Rows } from "@/ui/settings-layout";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { PriorityIcon } from "@/ui/icons";

/** What a template opens on the task, when it opens a question. */
export interface DecisionSkeleton {
  kind?: "choice" | "approval";
  question?: string;
  details?: string;
  options?: { label: string; description?: string }[];
}

export type Preset = NonNullable<Template["preset"]> & { decision?: DecisionSkeleton };

/** A project's task templates. */
export function ProjectTemplates({ project }: { project: Project }) {
  const all = useCollection("templates");
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const templates = useMemo(
    () =>
      Object.values(all)
        .filter((tp) => !tp.deleted_at && (!tp.project_id || tp.project_id === project.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all, project.id],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-ink-2">{t("templates.lead")}</p>
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-3.5" aria-hidden />
          {t("templates.new")}
        </Button>
      </div>
      {templates.length === 0 ? (
        <EmptyRow>{t("templates.none")}</EmptyRow>
      ) : (
        <Rows>
          {templates.map((tp) => {
            const preset = (tp.preset ?? {}) as Preset;
            return (
              <Row
                key={tp.id}
                title={tp.name}
                sub={
                  [tp.title && `“${tp.title}”`, !tp.project_id && t("templates.scope.workspace")]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                onClick={() => setEditing(tp)}
                meta={
                  <span className="flex items-center gap-1.5 max-sm:hidden">
                    {!!preset.priority && (
                      <PriorityIcon priority={preset.priority} title={tMaybe(`priority.${preset.priority}`)} />
                    )}
                    {preset.status && <Badge>{preset.status}</Badge>}
                    {(preset.labels ?? []).slice(0, 3).map((name) => (
                      <Badge key={name}>{name}</Badge>
                    ))}
                    {preset.decision && (
                      <Badge tone="accent">
                        <HelpCircle className="size-3" aria-hidden />
                        {t("templates.has.decision")}
                      </Badge>
                    )}
                  </span>
                }
                actions={
                  <>
                    <IconButton label={`${t("common.edit")}: ${tp.name}`} onClick={() => setEditing(tp)}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                    <IconButton label={`${t("s.delete")}: ${tp.name}`} onClick={() => setDeleting(tp)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </>
                }
              />
            );
          })}
        </Rows>
      )}
      {editing && (
        <TemplateDialog
          project={project}
          template={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("templates.delete.title", { name: deleting?.name ?? "" })}
        body={t("templates.delete.body")}
        confirm={t("s.delete")}
        onConfirm={() => mutate({ type: "template.delete", args: { id: deleting?.id } }, undefined, { quiet: true })}
      />
    </div>
  );
}

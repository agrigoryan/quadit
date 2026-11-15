// "Restore one thing…": bring a single task or page back from a backup, as
// it was then. Deleted ones return and changed ones are set back; a page's
// newer blocks go to its trash. Everything else stays as it is now.

import { useState } from "react";
import { api } from "@/data/api";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import type { Backup } from "@/admin/backups";
import { useAdminWorkspaces } from "@/admin/workspaces";
import { Segmented } from "@/ui/segmented";
import { FormField, NativeSelect, Note, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { readError } from "@/data/query";
import { Input } from "@/ui/input";

type Kind = "task" | "doc";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A page's id, from the id itself or from a link to the page pasted whole. */
const pageIdOf = (text: string): string => text.match(UUID)?.[0].toLowerCase() ?? "";

/** A task's key, from the key itself ("sva-12") or from a link that ends in it. */
const taskKeyOf = (text: string): string =>
  text
    .trim()
    .match(/([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?:[#?].*)?$/)?.[1]
    ?.toUpperCase() ?? "";

export function RestoreItemDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const workspaces = useAdminWorkspaces();
  const open = workspaces.data?.filter((w) => !w.deleted_at);
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<Kind>("task");
  const [ref, setRef] = useState("");
  const errors = useFieldErrors(["ref"]);
  const workspace = slug || open?.[0]?.slug || "";

  function pickKind(next: Kind) {
    setKind(next);
    setRef("");
    errors.clear();
  }

  async function submit() {
    const key = taskKeyOf(ref);
    const doc = pageIdOf(ref);
    if (kind === "task" && !key) refuse("ref", t("admin.restoreItem.taskBad"));
    if (kind === "doc" && !doc) refuse("ref", t("admin.restoreItem.pageBad"));
    await api.post(
      `/api/v1/admin/backups/${backup.id}/restore-item`,
      kind === "task" ? { workspace, task: key } : { workspace, doc },
    );
    toast.info(kind === "task" ? t("admin.restoreItem.doneTask", { key }) : t("admin.restoreItem.donePage"));
  }

  return (
    <FormDialog
      title={t("admin.restoreItem.title")}
      description={t("admin.restoreItem.from", { when: exact(backup.started_at) })}
      size="sm"
      submit={t("admin.restoreItem.restore")}
      submitting={t("admin.restoreItem.busy")}
      ready={!!workspace}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField
        label={t("admin.restoreItem.workspace")}
        htmlFor="ri-workspace"
        error={readError(workspaces.error) || undefined}
      >
        <NativeSelect
          id="ri-workspace"
          value={workspace}
          onChange={setSlug}
          options={(open ?? []).map((w) => ({ value: w.slug, label: `${w.name} (/${w.slug})` }))}
        />
      </FormField>
      <Segmented
        label={t("admin.restoreItem.what")}
        value={kind}
        onChange={pickKind}
        options={[
          { value: "task", label: t("admin.restoreItem.task") },
          { value: "doc", label: t("admin.restoreItem.page") },
        ]}
      />
      <FormField
        label={kind === "task" ? t("admin.restoreItem.taskKey") : t("admin.restoreItem.pageLink")}
        htmlFor="ri-ref"
        hint={kind === "task" ? t("admin.restoreItem.taskHint") : t("admin.restoreItem.pageHint")}
        error={errors.fields.ref}
      >
        <Input
          id="ri-ref"
          autoFocus
          value={ref}
          onChange={(e) => {
            setRef(e.target.value);
            errors.clear();
          }}
          placeholder={kind === "task" ? "SVA-12" : "https://…/docs/…"}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          className={kind === "task" ? "font-mono uppercase placeholder:normal-case" : undefined}
        />
      </FormField>
      <Note>{kind === "task" ? t("admin.restoreItem.noteTask") : t("admin.restoreItem.notePage")}</Note>
    </FormDialog>
  );
}

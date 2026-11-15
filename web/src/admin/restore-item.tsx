// "Restore one thing…": bring a single task or page back from a backup, as
// it was then. Deleted ones return and changed ones are set back; a page's
// newer blocks go to its trash. Everything else stays as it is now.

import { type FormEvent, useState } from "react";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import type { Backup } from "@/admin/backups";
import { fetchWorkspaces } from "@/admin/workspaces";
import { Segmented } from "@/settings/me/segmented";
import { FormAlert, FormField, NativeSelect, Note, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { useLoad } from "@/settings/ui/use-load";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
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
  const workspaces = useLoad(() => fetchWorkspaces().then((rows) => rows.filter((w) => !w.deleted_at)), []);
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<Kind>("task");
  const [ref, setRef] = useState("");
  const errors = useFieldErrors(["ref"]);
  const { busy, run } = useSubmit(errors, { once: true });
  const workspace = slug || workspaces.data?.[0]?.slug || "";

  function pickKind(next: Kind) {
    setKind(next);
    setRef("");
    errors.clear();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const key = taskKeyOf(ref);
    const doc = pageIdOf(ref);
    if (kind === "task" && !key) return errors.set("ref", t("admin.restoreItem.taskBad"));
    if (kind === "doc" && !doc) return errors.set("ref", t("admin.restoreItem.pageBad"));
    await run(async () => {
      await api.post(
        `/api/v1/admin/backups/${backup.id}/restore-item`,
        kind === "task" ? { workspace, task: key } : { workspace, doc },
      );
      toast.info(kind === "task" ? t("admin.restoreItem.doneTask", { key }) : t("admin.restoreItem.donePage"));
      onClose();
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("admin.restoreItem.title")}
      description={t("admin.restoreItem.from", { when: exact(backup.started_at) })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="restore-item" disabled={busy || !workspace}>
            {busy ? t("admin.restoreItem.busy") : t("admin.restoreItem.restore")}
          </Button>
        </>
      }
    >
      <form id="restore-item" onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        <FormField
          label={t("admin.restoreItem.workspace")}
          htmlFor="ri-workspace"
          error={workspaces.error || undefined}
        >
          <NativeSelect
            id="ri-workspace"
            value={workspace}
            onChange={setSlug}
            options={(workspaces.data ?? []).map((w) => ({ value: w.slug, label: `${w.name} (/${w.slug})` }))}
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
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

import { type FormEvent, useState } from "react";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import type { Member } from "@/lib/types";
import { FormAlert, FormField, useFieldErrors } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

/** Changes how a member is mentioned and described in this workspace. */
export function EditMemberDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const [handle, setHandle] = useState(member.handle);
  const [title, setTitle] = useState(member.title ?? "");
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["handle", "title"]);

  async function save(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    setBusy(true);
    try {
      await mutate({ type: "member.update", args: { id: member.user_id, handle: handle.trim(), title: title.trim() } }, undefined, { quiet: true });
      onClose();
    } catch (err) {
      errors.fail(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("members.editTitle", { name: member.name })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="edit-member" disabled={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="edit-member" onSubmit={save} className="flex flex-col gap-3.5">
        <FormField label={t("members.handle")} htmlFor="m-handle" hint={t("members.handleHint", { handle: handle || member.handle })} error={errors.fields.handle}>
          <Input id="m-handle" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} autoCapitalize="none" spellCheck={false} />
        </FormField>
        <FormField label={t("members.titleField")} htmlFor="m-title" hint={t("members.titleHint")} error={errors.fields.title}>
          <Input id="m-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

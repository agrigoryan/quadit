// Deleting the workspace: only an owner can, and only by typing its address.
// Everyone loses access at once; an admin of the install can bring it back
// for 30 days, after which it is removed for good.

import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { loadSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import { toast } from "@/lib/toast";
import type { Workspace } from "@/types/core";
import { FormAlert, FormField, useFieldErrors } from "@/ui/form";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

export function DeleteWorkspaceDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["confirm"]);
  const matches = typed.trim() === workspace.slug;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    errors.clear();
    setBusy(true);
    try {
      await mutate({ type: "workspace.delete", args: { confirm: workspace.slug } }, undefined, { quiet: true });
    } catch (err) {
      errors.fail(err);
      setBusy(false);
      return;
    }
    // The workspaces the person still has come with the session; "/" then opens one, or offers to make one.
    await loadSession().catch(() => {});
    toast.info(t("general.delete.done", { name: workspace.name }));
    void navigate("/", { replace: true });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t("general.delete.title", { name: workspace.name })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" type="submit" form="delete-workspace" disabled={!matches || busy}>
            {busy ? t("general.delete.busy") : t("general.delete.confirm")}
          </Button>
        </>
      }
    >
      <form id="delete-workspace" onSubmit={submit} className="flex flex-col gap-3.5">
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-ink-2">
          <li>{t("general.delete.everyone")}</li>
          <li>{t("general.delete.restore")}</li>
          <li>{t("general.delete.export")}</li>
        </ul>
        <FormField
          label={t("general.delete.type", { slug: workspace.slug })}
          htmlFor="ws-delete-confirm"
          error={errors.fields.confirm}
        >
          <Input
            id="ws-delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            placeholder={workspace.slug}
          />
        </FormField>
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

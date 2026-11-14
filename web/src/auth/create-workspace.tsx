import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { AuthLayout } from "@/auth/auth-layout";
import { slugFrom } from "@/auth/config";
import { createWorkspace, signOut, useSession } from "@/auth/session";
import { ApiError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FormAlert, FormField, useFieldErrors } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Makes another workspace on this install, owned by the person signed in, and goes to it. */
export function CreateWorkspaceDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  /** Empty until the person types their own; the address then follows the name. */
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["workspace_slug", "workspace_name"]);
  const address = slug || slugFrom(name);

  function change(next: boolean) {
    if (!next) {
      setName("");
      setSlug("");
      errors.clear();
    }
    onOpenChange(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      errors.set("workspace_name", t("auth.workspace.nameNeeded"));
      return;
    }
    setBusy(true);
    errors.clear();
    try {
      const made = await createWorkspace(name, address);
      change(false);
      navigate(`/${made}`);
    } catch (err) {
      // A taken address is refused without naming the field; it is the address that needs changing.
      if (err instanceof ApiError && err.code === "conflict" && !err.field) errors.set("workspace_slug", err.message);
      else errors.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t("auth.workspace.create")}
      description={t("auth.workspace.lead")}
      size="sm"
      footer={
        <>
          <Button onClick={() => change(false)}>{t("common.cancel")}</Button>
          <Button type="submit" form="create-workspace" variant="primary" disabled={busy}>
            {busy ? t("auth.setup.busy") : t("auth.workspace.create")}
          </Button>
        </>
      }
    >
      <form id="create-workspace" onSubmit={submit} className="flex flex-col gap-3.5">
        <FormField label={t("auth.setup.workspace")} htmlFor="ws-name" error={errors.fields.workspace_name}>
          <Input id="ws-name" required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField
          label={t("auth.workspace.address")}
          htmlFor="ws-slug"
          error={errors.fields.workspace_slug}
          hint={t("auth.workspace.addressHint", { address: `${window.location.host}/${address}` })}
        >
          <Input
            id="ws-slug"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={slugFrom(name)}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
          />
        </FormField>
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

/** What "/" shows to someone who is signed in but belongs to no workspace (a new registration, or removed from their last one). */
export function NoWorkspacePage() {
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  return (
    <AuthLayout
      title={t("auth.noWorkspace.title")}
      lead={t("auth.noWorkspace.lead")}
      footer={
        <p>
          {t("auth.noWorkspace.signedInAs", { email: user?.email ?? user?.name ?? "" })}{" "}
          <button type="button" onClick={() => void signOut()} className="font-medium text-accent-text underline-offset-2 hover:underline">
            {t("top.signOut")}
          </button>
        </p>
      }
    >
      <div className="flex flex-col gap-3">
        <Button variant="primary" size="lg" className="w-full" onClick={() => setOpen(true)}>
          {t("auth.workspace.create")}
        </Button>
        <p className="text-sm text-ink-2">{t("auth.noWorkspace.invite")}</p>
      </div>
      <CreateWorkspaceDialog open={open} onOpenChange={setOpen} />
    </AuthLayout>
  );
}

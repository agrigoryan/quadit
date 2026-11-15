import { useState } from "react";
import { useNavigate } from "react-router";
import { AuthLayout } from "@/auth/auth-layout";
import { slugFrom, useCanCreateWorkspace } from "@/auth/config";
import { createWorkspace, signOut, useSession } from "@/auth/session";
import { ApiError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FormField, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** Makes another workspace on this install, owned by the person signed in, and goes to it. Mount it only while it is open. */
export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  /** Empty until the person types their own; the address then follows the name. */
  const [slug, setSlug] = useState("");
  // The server names the address "slug" (or "workspace_slug") and the name "name" (or "workspace_name").
  const errors = useFieldErrors(["slug", "workspace_slug", "name", "workspace_name"]);
  const address = slug || slugFrom(name);

  async function submit() {
    if (!name.trim()) refuse("name", t("auth.workspace.nameNeeded"));
    let made: string;
    try {
      made = await createWorkspace(name, address);
    } catch (err) {
      // An older server refuses a taken address without naming the field; it is the address that needs changing.
      if (err instanceof ApiError && err.code === "conflict" && !err.field) refuse("slug", err.message);
      throw err;
    }
    void navigate(`/${made}`);
  }

  return (
    <FormDialog
      title={t("auth.workspace.create")}
      description={t("auth.workspace.lead")}
      size="sm"
      submit={t("auth.workspace.create")}
      submitting={t("auth.setup.busy")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField
        label={t("auth.setup.workspace")}
        htmlFor="ws-name"
        error={errors.fields.name || errors.fields.workspace_name}
      >
        <Input id="ws-name" required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField
        label={t("auth.workspace.address")}
        htmlFor="ws-slug"
        error={errors.fields.slug || errors.fields.workspace_slug}
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
    </FormDialog>
  );
}

/** What "/" shows to someone who is signed in but belongs to no workspace (a new registration, or removed from their last one). */
export function NoWorkspacePage() {
  const user = useSession((s) => s.user);
  const canCreate = useCanCreateWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <AuthLayout
      title={t("auth.noWorkspace.title")}
      lead={t("auth.noWorkspace.lead")}
      footer={
        <p>
          {t("auth.noWorkspace.signedInAs", { email: user?.email ?? user?.name ?? "" })}{" "}
          <button
            type="button"
            onClick={() => void signOut()}
            className="font-medium text-accent-text underline-offset-2 hover:underline"
          >
            {t("top.signOut")}
          </button>
        </p>
      }
    >
      <div className="flex flex-col gap-3">
        {canCreate && (
          <Button variant="primary" size="lg" className="w-full" onClick={() => setOpen(true)}>
            {t("auth.workspace.create")}
          </Button>
        )}
        <p className="text-sm text-ink-2">{t(canCreate ? "auth.noWorkspace.invite" : "auth.noWorkspace.inviteOnly")}</p>
      </div>
      {canCreate && open && <CreateWorkspaceDialog onClose={() => setOpen(false)} />}
    </AuthLayout>
  );
}

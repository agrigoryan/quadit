import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AuthLayout, FormError } from "@/auth/auth-layout";
import { authConfig, setUp } from "@/auth/session";
import { t } from "@/lib/i18n";
import { FormField, useFieldErrors, useSubmit } from "@/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** The first visit to a new install: make the owner and the first workspace. */
export function SetupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", workspace_name: "" });
  // The server names the workspace's address "slug"; it comes from the workspace's name here.
  const errors = useFieldErrors([
    "name",
    "owner_name",
    "email",
    "owner_email",
    "password",
    "slug",
    "workspace_slug",
    "workspace_name",
  ]);
  const { busy, run } = useSubmit(errors, { once: true });

  // Set-up works once; after that this page is the sign-in page.
  useEffect(() => {
    authConfig()
      .then((cfg) => !cfg.setup_needed && navigate("/login", { replace: true }))
      .catch(() => {});
  }, [navigate]);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const slug = await setUp(form);
      void navigate(`/${slug}`, { replace: true });
    });
  }

  return (
    <AuthLayout title={t("auth.setup.title")} lead={t("auth.setup.lead")}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <FormField label={t("auth.setup.name")} htmlFor="name" error={errors.fields.name || errors.fields.owner_name}>
          <Input
            id="name"
            autoComplete="name"
            autoFocus
            required
            className="h-10 text-base"
            value={form.name}
            onChange={set("name")}
          />
        </FormField>
        <FormField label={t("auth.email")} htmlFor="email" error={errors.fields.email || errors.fields.owner_email}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            className="h-10 text-base"
            value={form.email}
            onChange={set("email")}
          />
        </FormField>
        <FormField
          label={t("auth.password")}
          htmlFor="password"
          hint={t("auth.setup.passwordHint")}
          error={errors.fields.password}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            className="h-10 text-base"
            value={form.password}
            onChange={set("password")}
          />
        </FormField>
        <FormField
          label={t("auth.setup.workspace")}
          htmlFor="workspace"
          hint={t("auth.setup.workspaceHint")}
          error={errors.fields.workspace_name || errors.fields.slug || errors.fields.workspace_slug}
        >
          <Input
            id="workspace"
            required
            className="h-10 text-base"
            value={form.workspace_name}
            onChange={set("workspace_name")}
          />
        </FormField>
        <FormError>{errors.form}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.setup.busy") : t("auth.setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

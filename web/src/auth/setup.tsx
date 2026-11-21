import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AuthLayout, FormError } from "@/auth/auth-layout";
import { authConfig, authConfigKey, setUp } from "@/auth/session";
import { t } from "@/lib/i18n";
import { FormField, useFieldErrors, useSubmit } from "@/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { LoadGate } from "@/ui/load-gate";
import { askForSamples, samplesPath } from "@/tasks/samples";

/**
 * The first visit to a new install: make the owner and the first workspace.
 * An install the desktop app runs is set up by that app, so the page only
 * says so. Which of the two it is comes from the sign-in options: until they
 * are read the page shows only that it is loading, or why it could not.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const config = useQuery({ queryKey: authConfigKey, queryFn: authConfig });
  const setUpAlready = config.data?.setup_needed === false;

  // Set-up works once; after that this page is the sign-in page.
  useEffect(() => {
    if (setUpAlready) void navigate("/login", { replace: true });
  }, [setUpAlready, navigate]);

  if (config.data && !config.data.setup_by_app) return <SetupForm />;
  return (
    <AuthLayout title={t("auth.setup.title")}>
      <LoadGate of={config}>{() => <p className="text-sm text-ink-2">{t("auth.setup.byApp")}</p>}</LoadGate>
    </AuthLayout>
  );
}

/**
 * Where a new install opens: the task list of the sample tasks the set-up
 * made, or My work when they cannot be found (the install is set up all the
 * same).
 */
async function landing(slug: string): Promise<string> {
  try {
    return samplesPath(slug, await askForSamples(slug));
  } catch {
    return `/${slug}`;
  }
}

function SetupForm() {
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

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const slug = await setUp(form);
      void navigate(await landing(slug), { replace: true });
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

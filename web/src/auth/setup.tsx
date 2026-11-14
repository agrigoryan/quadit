import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AuthLayout, FormError } from "@/auth/auth-layout";
import { authConfig, setUp } from "@/auth/session";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/input";

/** The first visit to a new install: make the owner and the first workspace. */
export function SetupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", workspace_name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError("");
    try {
      const slug = await setUp(form);
      navigate(`/${slug}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t("auth.setup.title")} lead={t("auth.setup.lead")}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("auth.setup.name")} htmlFor="name">
          <Input id="name" autoComplete="name" autoFocus required className="h-10 text-base" value={form.name} onChange={set("name")} />
        </Field>
        <Field label={t("auth.email")} htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required className="h-10 text-base" value={form.email} onChange={set("email")} />
        </Field>
        <Field label={t("auth.password")} htmlFor="password" hint={t("auth.setup.passwordHint")}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            className="h-10 text-base"
            value={form.password}
            onChange={set("password")}
          />
        </Field>
        <Field label={t("auth.setup.workspace")} htmlFor="workspace" hint={t("auth.setup.workspaceHint")}>
          <Input id="workspace" required className="h-10 text-base" value={form.workspace_name} onChange={set("workspace_name")} />
        </Field>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.setup.busy") : t("auth.setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

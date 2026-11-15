import { type FormEvent, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { AuthLayout, FormError, OrLine, TextLink } from "@/auth/auth-layout";
import { safeNext, useAuthConfig } from "@/auth/config";
import { ProviderButtons } from "@/auth/providers";
import { register, useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { FormField, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Loading } from "@/ui/spinner";

/** Make an account, on an install that lets anyone do so. Everywhere else people join by invitation. */
export function RegisterPage() {
  const status = useSession((s) => s.status);
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const errors = useFieldErrors(["name", "email", "password"]);
  const { busy, run } = useSubmit(errors, { once: true });
  const next = safeNext(params.get("next"));

  if (status === "in") return <Navigate to={next} replace />;
  if (!config) return <Loading />;

  const signInLink = (
    <p>
      {t("auth.register.have")} <TextLink to="/login">{t("auth.signIn.submit")}</TextLink>
    </p>
  );

  if (!config.registration) {
    return (
      <AuthLayout title={t("auth.register.closedTitle")} footer={signInLink}>
        <p className="text-sm text-ink-2">{t("auth.register.closed")}</p>
      </AuthLayout>
    );
  }

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await register(form);
    });
  }

  return (
    <AuthLayout title={t("auth.register.title")} lead={t("auth.register.lead", { name: config.name })} footer={signInLink}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <FormField label={t("auth.setup.name")} htmlFor="name" error={errors.fields.name}>
          <Input id="name" autoComplete="name" autoFocus required className="h-10 text-base" value={form.name} onChange={set("name")} />
        </FormField>
        <FormField label={t("auth.email")} htmlFor="email" error={errors.fields.email}>
          <Input id="email" type="email" autoComplete="username" required className="h-10 text-base" value={form.email} onChange={set("email")} />
        </FormField>
        <FormField label={t("auth.password")} htmlFor="password" hint={t("auth.setup.passwordHint")} error={errors.fields.password}>
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
        <FormError>{errors.form}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.register.busy") : t("auth.register.submit")}
        </Button>
      </form>
      {config.providers.length > 0 && (
        <div className="flex flex-col gap-2">
          <OrLine>{t("auth.or")}</OrLine>
          <ProviderButtons providers={config.providers} query={`next=${encodeURIComponent(next)}`} />
        </div>
      )}
    </AuthLayout>
  );
}

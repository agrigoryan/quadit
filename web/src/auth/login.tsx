import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { AuthLayout, FormError } from "@/auth/auth-layout";
import { authConfig, signIn, useSession } from "@/auth/session";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/input";

export function LoginPage() {
  const status = useSession((s) => s.status);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondStep, setSecondStep] = useState(false);
  const next = params.get("next") || "/";

  // A fresh install has nobody to sign in as yet.
  useEffect(() => {
    authConfig()
      .then((cfg) => cfg.setup_needed && navigate("/setup", { replace: true }))
      .catch(() => {});
  }, [navigate]);

  if (status === "in") return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if ((await signIn(email, password)) === "second_step") setSecondStep(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (secondStep) {
    return (
      <AuthLayout title={t("auth.secondStep.title")} lead={t("auth.secondStep.lead")}>
        <Button variant="secondary" size="lg" className="w-full" onClick={() => setSecondStep(false)}>
          {t("auth.secondStep.back")}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.signIn.title")}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("auth.email")} htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            className="h-10 text-base"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t("auth.password")} htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            className="h-10 text-base"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.signIn.busy") : t("auth.signIn.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

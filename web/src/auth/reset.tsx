import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AuthLayout, FormError, TextLink } from "@/auth/auth-layout";
import { useAuthConfig } from "@/auth/config";
import { api, ApiError, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FormField, Note } from "@/ui/form";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/input";

const backToSignIn = () => (
  <p>
    <TextLink to="/login">{t("auth.backToSignIn")}</TextLink>
  </p>
);

/** "Forgot password": asks for the address and has the server mail a link. */
export function ResetRequestPage() {
  const config = useAuthConfig();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** An install with no mail server cannot send a link; the server says what to do instead. */
  const [noMail, setNoMail] = useState("");
  const [sentTo, setSentTo] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNoMail("");
    try {
      await api.post("/api/v1/auth/reset/request", { email: email.trim() });
      setSentTo(email.trim());
    } catch (err) {
      if (err instanceof ApiError && err.code === "no_mail") setNoMail(err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout title={t("auth.reset.sentTitle")} footer={backToSignIn()}>
        <div className="flex flex-col gap-3 text-sm text-ink-2">
          {/* The same words whether or not the address has an account: it tells an outsider nothing. */}
          <p>{t("auth.reset.sent", { email: sentTo })}</p>
          <p>{t("auth.reset.sentHint")}</p>
          <Button className="self-start" onClick={() => setSentTo("")}>
            {t("auth.reset.another")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // An install that cannot send mail says so before anyone types an address.
  if (config?.mail === false) {
    return (
      <AuthLayout title={t("auth.reset.title")} footer={backToSignIn()}>
        <Note tone="wait">
          <span className="flex flex-col gap-1.5">
            <span>{t("auth.reset.noMail")}</span>
            <span>{t("auth.reset.noMailHow")}</span>
            <code className="font-mono text-xs break-all text-ink">quadit admin reset-password &lt;email&gt;</code>
          </span>
        </Note>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.reset.title")} lead={t("auth.reset.lead")} footer={backToSignIn()}>
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
        {noMail && (
          <div role="alert" className="first-letter:uppercase">
            <Note tone="wait">{noMail}</Note>
          </div>
        )}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.reset.busy") : t("auth.reset.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** The page a reset link opens: choose the new password. */
export function ResetConfirmPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  /** The link is spent or too old: nothing more can be done with this page. */
  const [gone, setGone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFieldError("");
    try {
      await api.post("/api/v1/auth/reset/confirm", { token, password });
      void navigate("/login", { replace: true, state: { notice: t("auth.reset.done") } });
    } catch (err) {
      if (err instanceof ApiError && err.field === "password") setFieldError(err.message);
      else {
        setError(errorMessage(err));
        setGone(err instanceof ApiError && err.status === 404);
      }
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <AuthLayout title={t("auth.reset.goneTitle")} footer={backToSignIn()}>
        <div className="flex flex-col gap-3">
          <FormError>{error}</FormError>
          <p className="text-sm text-ink-2">
            <TextLink to="/reset">{t("auth.reset.again")}</TextLink>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.reset.newTitle")} lead={t("auth.reset.newLead")} footer={backToSignIn()}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <FormField
          label={t("auth.newPassword")}
          htmlFor="password"
          hint={t("auth.setup.passwordHint")}
          error={fieldError}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            aria-invalid={!!fieldError}
            className="h-10 text-base"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.reset.saving") : t("auth.reset.save")}
        </Button>
      </form>
    </AuthLayout>
  );
}

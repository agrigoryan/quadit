import { type FormEvent, useState } from "react";
import { AuthLayout, FormError } from "@/auth/auth-layout";
import { secondStep, signOut } from "@/auth/session";
import { ApiError, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FormField } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/**
 * The second step of signing in: a six-digit code from the authenticator
 * app, or one of the recovery codes. The first step is already done; going
 * back signs that half-finished session out.
 */
export function SecondStep() {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  /** A refusal about the code itself goes under the field; anything else above the button. */
  const [codeError, setCodeError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(value: string) {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError("");
    setCodeError("");
    try {
      // On success the session is whole and the sign-in page moves on by itself.
      await secondStep(value);
    } catch (err) {
      if (err instanceof ApiError && err.field === "code") setCodeError(err.message);
      else setError(errorMessage(err));
      setCode("");
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(code);
  }

  function typed(value: string) {
    if (recovery) {
      setCode(value);
      return;
    }
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    // Six digits is the whole code: no need to press anything.
    if (digits.length === 6) void send(digits);
  }

  function swap() {
    setRecovery((r) => !r);
    setCode("");
    setError("");
    setCodeError("");
  }

  return (
    <AuthLayout
      title={t("auth.secondStep.title")}
      lead={recovery ? t("auth.second.recoveryLead") : t("auth.second.lead")}
      footer={
        <>
          <button
            type="button"
            onClick={swap}
            className="self-start font-medium text-accent-text underline-offset-2 hover:underline"
          >
            {recovery ? t("auth.second.useCode") : t("auth.second.useRecovery")}
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="self-start text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            {t("auth.second.back")}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        {recovery ? (
          <FormField
            label={t("auth.second.recovery")}
            htmlFor="recovery"
            hint={t("auth.second.recoveryHint")}
            error={codeError}
          >
            <Input
              key="recovery"
              id="recovery"
              autoFocus
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxxx-xxxxx"
              className="h-10 font-mono text-base"
              value={code}
              aria-invalid={!!codeError}
              onChange={(e) => typed(e.target.value)}
            />
          </FormField>
        ) : (
          <FormField label={t("auth.second.code")} htmlFor="code" error={codeError}>
            <Input
              key="code"
              id="code"
              autoFocus
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              className="h-11 pl-[calc(0.625rem+0.4em)] text-center font-mono text-lg tracking-[0.4em] tnum"
              value={code}
              aria-invalid={!!codeError}
              onChange={(e) => typed(e.target.value)}
            />
          </FormField>
        )}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? t("auth.second.busy") : t("auth.second.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

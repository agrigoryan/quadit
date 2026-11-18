import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AuthLayout, FormError, OrLine } from "@/auth/auth-layout";
import { PasskeyButton } from "@/auth/providers";
import { secondStep, secondStepWays, signOut } from "@/auth/session";
import { t } from "@/lib/i18n";
import { FormField, useFieldErrors } from "@/ui/form";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/**
 * The second step of signing in, in the ways the person has: a six-digit
 * code from the authenticator app or one of the recovery codes, and, where
 * the install requires two steps, their passkey (signing in with it is both
 * steps at once). The first step is already done; going back signs that
 * half-finished session out.
 */
export function SecondStep() {
  // Until the server says, the code is offered: it is the second step most people have.
  const ways = useQuery({ queryKey: ["auth", "second-step"], queryFn: secondStepWays }).data;
  const withCode = ways?.code ?? true;
  const withPasskey = ways?.passkey ?? false;
  const [recovery, setRecovery] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");
  const [code, setCode] = useState("");
  /** A refusal about the code itself goes under the field; anything else above the button. */
  const errors = useFieldErrors(["code"]);
  const codeError = errors.fields.code;
  const [busy, setBusy] = useState(false);

  async function send(value: string) {
    if (busy || !value.trim()) return;
    setBusy(true);
    errors.clear();
    try {
      // On success the session is whole and the sign-in page moves on by itself.
      await secondStep(value);
    } catch (err) {
      errors.fail(err);
      // A refused code is cleared for the next try.
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
    errors.clear();
  }

  const lead = !withCode
    ? t("auth.second.passkeyLead")
    : recovery
      ? t("auth.second.recoveryLead")
      : t("auth.second.lead");
  return (
    <AuthLayout
      title={t("auth.secondStep.title")}
      lead={lead}
      footer={
        <>
          {withCode && (
            <button
              type="button"
              onClick={swap}
              className="self-start font-medium text-accent-text underline-offset-2 hover:underline"
            >
              {recovery ? t("auth.second.useCode") : t("auth.second.useRecovery")}
            </button>
          )}
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
      <div className="flex flex-col gap-3.5">
        {withCode && (
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
            <FormError>{errors.form}</FormError>
            <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
              {busy ? t("auth.second.busy") : t("auth.second.submit")}
            </Button>
          </form>
        )}
        {withPasskey && (
          <div className="flex flex-col gap-2">
            {withCode && <OrLine>{t("auth.or")}</OrLine>}
            <PasskeyButton onError={setPasskeyError} />
            <FormError>{passkeyError}</FormError>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

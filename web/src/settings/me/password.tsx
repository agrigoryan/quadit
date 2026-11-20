import { type FormEvent, useState } from "react";
import { api, ApiError, errorMessage } from "@/data/api";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { FormAlert, FormField, FormFoot, useFieldErrors } from "@/ui/form";
import { Card, Section } from "@/ui/page-layout";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

interface Props {
  /** False for an account made through Google, GitHub or a passkey, or by the desktop app: it sets its first password here. */
  hasPassword: boolean;
  /** False for an install's owner the desktop app made, who signs in through the app until they add an email and a password. */
  hasEmail: boolean;
  /** Called after the change: other browsers were signed out, so lists are stale. */
  onChanged: () => void;
}

export function PasswordSection({ hasPassword, hasEmail, onChanged }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors(["current", "new", "again"]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (next !== again) {
      errors.set("again", t("me.password.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/v1/auth/password", { current, new: next });
      setCurrent("");
      setNext("");
      setAgain("");
      toast.info(hasPassword ? t("me.password.changed") : t("me.password.set"));
      onChanged();
    } catch (err) {
      // The server answers a wrong current password with a plain "forbidden": it belongs to that field.
      if (hasPassword && err instanceof ApiError && err.status === 403 && !err.field)
        errors.set("current", errorMessage(err));
      else errors.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t("me.password.title")}
      lead={hasPassword ? t("me.password.lead") : hasEmail ? t("me.password.leadNone") : t("me.signInFromBrowser")}
    >
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {hasPassword && (
            <FormField
              label={t("me.password.current")}
              htmlFor="pw-current"
              error={errors.fields.current}
              className="sm:max-w-xs"
            >
              <Input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </FormField>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("me.password.new")}
              htmlFor="pw-new"
              hint={t("auth.setup.passwordHint")}
              error={errors.fields.new}
            >
              <Input
                id="pw-new"
                type="password"
                autoComplete="new-password"
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </FormField>
            <FormField label={t("me.password.again")} htmlFor="pw-again" error={errors.fields.again}>
              <Input
                id="pw-again"
                type="password"
                autoComplete="new-password"
                required
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </FormField>
          </div>
          <FormAlert>{errors.form}</FormAlert>
          <FormFoot>
            <Button type="submit" variant="primary" disabled={busy || !next}>
              {busy ? t("s.saving") : hasPassword ? t("me.password.submit") : t("me.password.submitSet")}
            </Button>
          </FormFoot>
        </form>
      </Card>
    </Section>
  );
}

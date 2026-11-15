// The pattern every settings page of the admin area uses: a form around one
// setting, locked when the environment sets it, with Save at its foot.

import { type FormEvent, type ReactNode, useId } from "react";
import { Lock } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Input, Textarea } from "@/ui/input";
import { type Draft, MASK } from "@/admin/settings";
import { FormAlert, FormField, FormFoot } from "@/settings/ui/form";
import { Card } from "@/settings/ui/layout";

/** Says a setting comes from the environment and names the variable to change. */
function LockNote({ env }: { env: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-sunken px-2.5 py-2 text-sm text-ink-2">
      <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0">
        {t("admin.locked")} <code className="font-mono text-xs break-all text-ink">{env}</code>
      </span>
    </p>
  );
}

interface FormProps<T> {
  of: Draft<T>;
  children: ReactNode;
  /** More buttons beside Save ("Send a test"). */
  extra?: ReactNode;
  /** Something under the fields and above the buttons (a test's result). */
  below?: ReactNode;
}

/** A card with a setting's fields. Save is live only when something changed and nothing locks it. */
export function SettingForm<T>({ of, children, extra, below }: FormProps<T>) {
  function submit(e: FormEvent) {
    e.preventDefault();
    void of.submit();
  }
  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        {of.locked && <LockNote env={of.env} />}
        <fieldset disabled={of.locked} className="flex min-w-0 flex-col gap-3.5 disabled:opacity-70">
          {children}
        </fieldset>
        {below}
        <FormAlert>{of.errors.form}</FormAlert>
        <FormFoot status={of.saved && !of.dirty ? t("s.saved") : undefined}>
          {extra}
          <Button type="submit" variant="primary" disabled={of.locked || of.busy || !of.dirty}>
            {of.busy ? t("s.saving") : t("common.save")}
          </Button>
        </FormFoot>
      </form>
    </Card>
  );
}

interface TextProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  autoComplete?: string;
  className?: string;
}

/** A labelled text field. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  type = "text",
  mono,
  autoComplete = "off",
  className,
}: TextProps) {
  const id = useId();
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} className={className}>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        className={mono ? "font-mono text-xs" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </FormField>
  );
}

interface NumberProps extends Omit<TextProps, "value" | "onChange" | "type" | "mono"> {
  /** Undefined when the field is empty: the server's default applies. */
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  /** Shown after the field: "MB", "per minute". */
  unit?: string;
}

/** A labelled whole number. Empty means "use the default". */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  min,
  max,
  unit,
  className,
}: NumberProps) {
  const id = useId();
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} className={className}>
      <span className="flex items-center gap-2">
        <span className="w-28 shrink-0">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value ?? ""}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            className="tnum"
            onChange={(e) => {
              const n = e.target.value === "" ? undefined : Number(e.target.value);
              onChange(n === undefined || Number.isNaN(n) ? undefined : Math.trunc(n));
            }}
          />
        </span>
        {unit && <span className="text-sm text-ink-3">{unit}</span>}
      </span>
    </FormField>
  );
}

interface SecretProps extends Omit<TextProps, "type" | "mono" | "placeholder"> {
  /** What the server has for this field: the mask when a secret is stored. */
  stored: unknown;
  /** A key file rather than a short secret: a taller field. */
  multiline?: boolean;
}

/**
 * A secret the server never sends back. A stored one arrives as the mask:
 * the field then stays empty and says so, and the mask is what gets saved
 * (the server keeps what it has) unless something new is typed. Emptying
 * the field after typing goes back to keeping the stored one.
 */
export function SecretField({ label, value, stored, onChange, hint, error, multiline, className }: SecretProps) {
  const id = useId();
  const has = stored === MASK;
  const shown = value === MASK ? "" : value;
  const placeholder = has ? t("admin.secret.stored") : undefined;
  const change = (typed: string) => onChange(typed === "" && has ? MASK : typed);
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error} className={className}>
      {multiline ? (
        <Textarea
          id={id}
          rows={4}
          value={shown}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={shown}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </FormField>
  );
}

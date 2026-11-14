// Form parts for settings pages: a field that can show what is wrong with
// it, a switch, a plain select, and the hook that puts the server's refusal
// next to the field it names.

import { type ReactNode, type SelectHTMLAttributes, useCallback, useId, useState } from "react";
import { Checkbox as RCheckbox, Switch as RSwitch } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { ApiError, errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  /** What is wrong with the value; replaces the hint and turns the label red. */
  error?: string;
  children: ReactNode;
  className?: string;
}

/** A label above a field, with a hint or an error under it. */
export function FormField({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const labelId = useId();
  const labelClass = cx("text-xs font-medium", error ? "text-danger" : "text-ink-2");
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)} {...(htmlFor ? {} : { role: "group", "aria-labelledby": labelId })}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        // No single field to point at (a select, a row of swatches): name the group instead.
        <span id={labelId} className={labelClass}>
          {label}
        </span>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger first-letter:uppercase">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-ink-3">{hint}</p>
      )}
    </div>
  );
}

/** A refusal that names no field, shown above a form's buttons. */
export function FormAlert({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-2 text-sm text-danger first-letter:uppercase">
      {children}
    </p>
  );
}

/** A quiet note inside a page: something to know, not an error. */
export function Note({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "wait" | "ok" }) {
  const tones = { neutral: "bg-sunken text-ink-2", wait: "bg-wait-soft text-wait", ok: "bg-ok-soft text-ok" };
  return <p className={cx("rounded-md px-2.5 py-2 text-sm", tones[tone])}>{children}</p>;
}

export interface FieldErrors {
  /** The message for a field, by the name the server uses for it. */
  fields: Record<string, string>;
  /** A refusal that names no field. */
  form: string;
  /** Sorts anything a call can throw into `fields` or `form`. */
  fail: (err: unknown) => void;
  /** Sets one field's message from the browser's own checks. */
  set: (field: string, message: string) => void;
  clear: () => void;
}

/**
 * Where a form keeps what is wrong. A server refusal that names a field
 * (error.field) lands next to that field; `known` lists the fields the form
 * shows, so a refusal about any other lands above the buttons.
 */
export function useFieldErrors(known: string[] = []): FieldErrors {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [form, setForm] = useState("");
  const knownKey = known.join(",");
  const fail = useCallback(
    (err: unknown) => {
      const names = knownKey ? knownKey.split(",") : [];
      // The server may name a nested field ("match.project_id"): try the whole name, then its last part.
      const field = err instanceof ApiError ? err.field : undefined;
      const hit = field ? [field, field.split(".").pop() as string].find((f) => names.length === 0 || names.includes(f)) : undefined;
      if (hit) {
        setFields({ [hit]: errorMessage(err) });
        setForm("");
      } else {
        setFields({});
        setForm(errorMessage(err));
      }
    },
    [knownKey],
  );
  const set = useCallback((field: string, message: string) => setFields((f) => ({ ...f, [field]: message })), []);
  const clear = useCallback(() => {
    setFields({});
    setForm("");
  }, []);
  return { fields, form, fail, set, clear };
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Said by screen readers when there is no visible label tied to it. */
  label?: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={cx(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-card transition-transform data-[state=checked]:translate-x-4" />
    </RSwitch.Root>
  );
}

interface SwitchRowProps extends Omit<SwitchProps, "label" | "id"> {
  title: string;
  hint?: ReactNode;
}

/** A switch with its name and a line about what it does; the whole row is its label. */
export function SwitchRow({ title, hint, ...rest }: SwitchRowProps) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </label>
      <span className="pt-0.5">
        <Switch id={id} {...rest} />
      </span>
    </div>
  );
}

interface CheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, children, disabled }: CheckProps) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <RCheckbox.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className={cx(
          "flex size-4 shrink-0 items-center justify-center rounded-xs border transition-colors disabled:opacity-50",
          checked ? "border-accent bg-accent text-accent-ink" : "border-line-strong bg-surface",
        )}
      >
        <RCheckbox.Indicator>
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className="text-sm text-ink select-none">
        {children}
      </label>
    </span>
  );
}

export interface Choice {
  value: string;
  label: string;
}

interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
}

/** The browser's own select, styled like the other fields: right on a phone, quick with keys. */
export function NativeSelect({ value, onChange, options, className, ...rest }: NativeSelectProps) {
  return (
    <span className={cx("relative inline-flex min-w-0", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          "h-8 w-full min-w-0 appearance-none rounded-md border border-line-strong bg-surface pr-7 pl-2.5 text-sm text-ink outline-none " +
          "transition-colors hover:border-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
        }
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
    </span>
  );
}

/** Buttons at the foot of a form, with room for "Saved" or an error at the left. */
export function FormFoot({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
      {status && <span className="mr-auto text-sm text-ink-2">{status}</span>}
      {children}
    </div>
  );
}

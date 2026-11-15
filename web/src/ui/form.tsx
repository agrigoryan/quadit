// Form parts: a field that can show what is wrong with it, a switch, a plain
// select, the hook that puts the server's refusal next to the field it names,
// and the hook that runs a form's request.

import {
  createContext,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useContext,
  useId,
  useState,
} from "react";
import { Checkbox as RCheckbox, Switch as RSwitch } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { ApiError, errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";

interface FieldProps {
  label: string;
  /** The id of the one control the label names. Left out (a row of swatches, a picker), the field is a named group. */
  htmlFor?: string;
  hint?: ReactNode;
  /** What is wrong with the value; replaces the hint, turns the label red and marks the control invalid. */
  error?: string;
  children: ReactNode;
  className?: string;
}

/** What a field tells the control it names: the line that describes it, and whether its value is wrong. */
interface FieldControl {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/**
 * The aria-describedby and aria-invalid a control takes from the FormField
 * around it, when the field's htmlFor is this control's id. Input, Textarea
 * and NativeSelect use it, so a field's hint and error are read with the
 * control without each form wiring ids by hand.
 */
export function useFieldControl(id: string | undefined): {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
} {
  const field = useContext(FieldContext);
  if (!field || !id || field.id !== id) return {};
  return { "aria-describedby": field.describedBy, "aria-invalid": field.invalid || undefined };
}

/** A label above a field, with a hint or an error under it. */
export function FormField({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const own = useId();
  const labelId = `${own}-label`;
  const noteId = `${own}-note`;
  const describedBy = error || hint ? noteId : undefined;
  const labelClass = cx("text-xs font-medium", error ? "text-danger" : "text-ink-2");
  return (
    <div
      className={cx("flex min-w-0 flex-col gap-1", className)}
      {...(htmlFor ? {} : { role: "group", "aria-labelledby": labelId, "aria-describedby": describedBy })}
    >
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
      <FieldContext value={htmlFor ? { id: htmlFor, describedBy, invalid: !!error } : null}>{children}</FieldContext>
      {error ? (
        <p id={noteId} role="alert" className="text-xs text-danger first-letter:uppercase">
          {error}
        </p>
      ) : (
        hint && (
          <p id={noteId} className="text-xs text-ink-3">
            {hint}
          </p>
        )
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
      const hit = field
        ? [field, field.split(".").pop() as string].find((f) => names.length === 0 || names.includes(f))
        : undefined;
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

/**
 * Stops a form's request from a check made in the browser, the same way a
 * server refusal does: thrown inside `run` (or a FormDialog's onSubmit), the
 * message lands on `field`, or above the buttons when the form does not show
 * that field.
 */
export function refuse(field: string, message: string): never {
  throw new ApiError(400, { code: "invalid", field, message });
}

interface Submit {
  /** The request is on its way: the form's button is off. */
  busy: boolean;
  /** Clears the old refusal, runs `action` with `busy` on, and sorts what it throws into the form's errors. */
  run: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * The busy flag of a form and the run of its request:
 *
 *   const { busy, run } = useSubmit(errors);
 *   await run(async () => {
 *     await mutate(...);
 *     toast.info(t("s.saved"));
 *   });
 *
 * A form that checks its fields in the browser first clears the errors itself
 * before checking, so an old refusal goes even when the check stops it short
 * of `run`.
 *
 * `once` is for a form that is over when its request goes through (its dialog
 * closes, the page moves on): `busy` then stays on, so the button cannot be
 * pressed again on the way out. A refusal turns it off either way.
 */
export function useSubmit(
  errors: Pick<FieldErrors, "clear" | "fail">,
  { once = false }: { once?: boolean } = {},
): Submit {
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    errors.clear();
    setBusy(true);
    try {
      await action();
    } catch (err) {
      errors.fail(err);
      setBusy(false);
      return;
    }
    if (!once) setBusy(false);
  }
  return { busy, run };
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
    <span className="inline-flex items-start gap-2">
      <RCheckbox.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className={cx(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs border transition-colors disabled:opacity-50",
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

interface Choice {
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
  const field = useFieldControl(rest.id);
  return (
    <span className={cx("relative inline-flex min-w-0", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          "h-8 w-full min-w-0 appearance-none rounded-md border border-line-strong bg-surface pr-7 pl-2.5 text-sm text-ink outline-none " +
          "transition-colors hover:border-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
        }
        {...field}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink-3"
        aria-hidden
      />
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

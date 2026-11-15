import { type FormEvent, useRef, useState } from "react";
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { docTitle } from "@/docs/data";
import { setViewConfig } from "@/docs/db/actions";
import { SelfCell } from "@/docs/db/cell";
import type { Value } from "@/docs/db/formula";
import { isComputed, PropIcon } from "@/docs/db/prop-meta";
import type { ViewProps } from "@/docs/db/use-table";
import type { DBProperty, DBView } from "@/lib/types-docs";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** The properties a form asks for: the ones chosen for it, or every one that can be filled in. */
export function formProps(props: DBProperty[], view: DBView): DBProperty[] {
  const fillable = props.filter((p) => !isComputed(p));
  const chosen = view.config?.form_props;
  if (!chosen) return fillable;
  return chosen.map((id) => fillable.find((p) => p.id === id)).filter((p): p is DBProperty => !!p);
}

const boxed = "rounded-md border border-line-strong bg-surface hover:border-ink-3";

function Field({ prop, value, onChange }: { prop: DBProperty; value: unknown; onChange: (v: unknown) => void }) {
  const id = `form-${prop.id}`;
  let control: React.ReactNode;
  if (prop.type === "text" || prop.type === "url") {
    control = (
      <Input
        id={id}
        type={prop.type === "url" ? "url" : "text"}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  } else if (prop.type === "number") {
    control = (
      <Input
        id={id}
        type="number"
        step="any"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  } else if (prop.type === "date") {
    control = (
      <Input
        id={id}
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  } else {
    control = (
      <SelfCell
        prop={prop}
        stored={value}
        shown={(value ?? undefined) as Value | undefined}
        onChange={onChange}
        wrap
        placeholder={t("db.form.choose")}
        className={prop.type === "checkbox" ? "w-auto" : `min-h-8 ${boxed}`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <PropIcon type={prop.type} />
        {prop.name}
      </label>
      {control}
    </div>
  );
}

/** A plain form of chosen properties. Sending it adds a row to the database. */
export function FormView({ db, view, onAdd }: ViewProps) {
  const fields = formProps(db.table.props, view);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [sent, setSent] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      first.current?.focus();
      return;
    }
    const filled: Record<string, unknown> = {};
    for (const p of fields) if (values[p.id] !== null && values[p.id] !== undefined) filled[p.id] = values[p.id];
    onAdd(filled, title.trim());
    setTitle("");
    setValues({});
    setSent(true);
  }

  return (
    <div className="mx-auto w-full max-w-xl py-4">
      <div className="rounded-xl border border-line bg-surface p-5 shadow-card max-sm:p-4">
        <h3 className="text-lg font-semibold">{docTitle(db.table.doc)}</h3>
        <textarea
          key={view.id}
          defaultValue={view.config?.form_intro ?? ""}
          onBlur={(e) =>
            e.target.value !== (view.config?.form_intro ?? "") &&
            setViewConfig(view, { form_intro: e.target.value || undefined })
          }
          placeholder={t("db.form.intro")}
          aria-label={t("db.form.intro")}
          rows={1}
          className="mt-1 w-full resize-none bg-transparent text-sm text-ink-2 outline-none [field-sizing:content] placeholder:text-ink-3"
        />
        {sent ? (
          <div className="mt-4 flex flex-col items-start gap-3">
            <p role="status" className="flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
              <Check className="size-4" aria-hidden />
              {t("db.form.sent")}
            </p>
            <Button onClick={() => setSent(false)}>{t("db.form.another")}</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="form-title" className="text-xs font-medium text-ink-2">
                {t("db.title")}
              </label>
              <Input ref={first} id="form-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            {fields.map((p) => (
              <Field
                key={p.id}
                prop={p}
                value={values[p.id]}
                onChange={(v) => setValues((cur) => ({ ...cur, [p.id]: v }))}
              />
            ))}
            <div>
              <Button type="submit" variant="primary">
                {t("db.form.submit")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

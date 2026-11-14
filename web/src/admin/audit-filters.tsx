// The filter bar above an audit log, and how its choices become a query.

import { useId } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { FormField, NativeSelect } from "@/settings/ui/form";

export interface Named {
  id: string;
  name: string;
}

export interface AuditFilters {
  /** An action, or a pattern with * ("signin*"). */
  action: string;
  actor: string;
  workspace: string;
  /** Calendar days, YYYY-MM-DD, in the person's own time zone; both included. */
  from: string;
  to: string;
}

export const noFilters: AuditFilters = { action: "", actor: "", workspace: "", from: "", to: "" };

export const anyFilter = (f: AuditFilters) => Object.values(f).some(Boolean);

function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

/** The query string for the filters. `extra` adds the page size, the `cursor` of the next page, or the format. */
export function auditQuery(f: AuditFilters, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (f.action.trim()) q.set("action", f.action.trim());
  if (f.actor) q.set("actor", f.actor);
  if (f.workspace) q.set("workspace", f.workspace);
  if (f.from) q.set("after", String(dayStart(f.from) - 1));
  if (f.to) q.set("before", String(dayStart(f.to) + 24 * 3600_000));
  for (const [key, value] of Object.entries(extra)) q.set(key, String(value));
  return q.toString();
}

// Patterns worth offering: the families of actions the server records.
const SUGGESTED = ["signin*", "password.*", "second_step.*", "passkey.*", "identity.*", "token.*", "invite.*", "account.registered", "user.changed", "setting.changed", "backup.*", "workspace.*", "secret.*", "audit.exported"];

interface Props {
  value: AuditFilters;
  onChange: (next: AuditFilters) => void;
  actors?: Named[];
  workspaces?: Named[];
}

export function AuditFilterBar({ value, onChange, actors, workspaces }: Props) {
  const id = useId();
  const set = (patch: Partial<AuditFilters>) => onChange({ ...value, ...patch });
  return (
    <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2.5 sm:flex sm:flex-wrap">
      <FormField label={t("audit.filter.action")} htmlFor={`${id}-action`} className="col-span-2 sm:w-48">
        <Input
          id={`${id}-action`}
          value={value.action}
          onChange={(e) => set({ action: e.target.value })}
          placeholder={t("audit.filter.actionPlaceholder")}
          list={`${id}-actions`}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <datalist id={`${id}-actions`}>
          {SUGGESTED.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </FormField>
      {actors && (
        <FormField label={t("audit.filter.actor")} htmlFor={`${id}-actor`} className="sm:w-40">
          <NativeSelect
            id={`${id}-actor`}
            value={value.actor}
            onChange={(actor) => set({ actor })}
            options={[{ value: "", label: t("s.anyone") }, ...actors.map((a) => ({ value: a.id, label: a.name }))]}
          />
        </FormField>
      )}
      {workspaces && (
        <FormField label={t("audit.filter.workspace")} htmlFor={`${id}-ws`} className="sm:w-40">
          <NativeSelect
            id={`${id}-ws`}
            value={value.workspace}
            onChange={(workspace) => set({ workspace })}
            options={[{ value: "", label: t("audit.filter.anyWorkspace") }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
          />
        </FormField>
      )}
      <FormField label={t("audit.filter.from")} htmlFor={`${id}-from`} className="min-w-0">
        <Input id={`${id}-from`} type="date" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} className="tnum" />
      </FormField>
      <FormField label={t("audit.filter.to")} htmlFor={`${id}-to`} className="min-w-0">
        <Input id={`${id}-to`} type="date" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} className="tnum" />
      </FormField>
      {anyFilter(value) && (
        <Button variant="ghost" className="h-8 justify-self-start" onClick={() => onChange(noFilters)}>
          <X className="size-3.5" aria-hidden />
          {t("audit.filter.clear")}
        </Button>
      )}
    </div>
  );
}

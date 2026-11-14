// The fields of an agent, shared by "New agent" and the agent's own page.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useMembers, useProjects } from "@/lib/selectors";
import { type AgentMember, dollars, toMicros, toMinutes } from "@/settings/agents/data";
import { MultiPick } from "@/settings/ui/multi-pick";
import { type FieldErrors, FormField, NativeSelect, SwitchRow } from "@/settings/ui/form";
import { ProjectGlyph } from "@/shell/sidebar";
import { Input, Textarea } from "@/ui/input";

export interface AgentDraft {
  name: string;
  handle: string;
  description: string;
  role: "member" | "admin";
  /** A person's user id, or "" for "leave as it is". */
  responsible: string;
  projects: string[];
  readOnly: boolean;
  approval: string[];
  money: string;
  minutes: string;
}

export const AGENT_FIELDS = ["name", "handle", "description", "role", "responsible", "projects", "needs_approval", "cost_micros", "minutes"];

export function draftOf(agent: AgentMember | undefined, responsible: string): AgentDraft {
  return {
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    description: agent?.title ?? "",
    role: agent?.role === "admin" ? "admin" : "member",
    responsible,
    projects: agent?.scope?.projects ?? [],
    readOnly: agent?.scope?.read_only ?? false,
    approval: agent?.scope?.needs_approval ?? [],
    money: dollars(agent?.budget?.cost_micros),
    minutes: agent?.budget?.minutes ? String(agent.budget.minutes) : "",
  };
}

/** The scope and budget arguments for agent.create / agent.update, or the field that is wrong. */
export function limitsOf(d: AgentDraft): { scope: object | null; budget: object | null } | { bad: "cost_micros" | "minutes" } {
  const cost = toMicros(d.money);
  const minutes = toMinutes(d.minutes);
  if (cost === null) return { bad: "cost_micros" };
  if (minutes === null) return { bad: "minutes" };
  const scoped = d.projects.length > 0 || d.readOnly || d.approval.length > 0;
  return {
    scope: scoped ? { projects: d.projects, read_only: d.readOnly, needs_approval: d.approval } : null,
    budget: cost > 0 || minutes > 0 ? { cost_micros: cost, minutes } : null,
  };
}

let changeTypes: Promise<string[]> | null = null;

/** Every change type the server knows, for "changes that need approval". Fetched once. */
function useChangeTypes(): string[] {
  const [types, setTypes] = useState<string[]>([]);
  useEffect(() => {
    changeTypes ??= api.get<{ changes: { type: string }[] }>("/api/v1/changes").then((r) => r.changes.map((c) => c.type).sort());
    changeTypes.then(setTypes).catch(() => {
      changeTypes = null;
    });
  }, []);
  return types;
}

interface Props {
  draft: AgentDraft;
  set: (patch: Partial<AgentDraft>) => void;
  errors: FieldErrors;
  /** The handle can be chosen only when the agent is made. */
  creating?: boolean;
  disabled?: boolean;
}

export function AgentProfileFields({ draft, set, errors, creating, disabled }: Props) {
  const people = useMembers().filter((m) => m.kind === "person" && !m.suspended_at);
  const responsibleChoices = [
    ...(draft.responsible && people.some((p) => p.user_id === draft.responsible) ? [] : [{ value: "", label: creating ? t("common.you") : t("agent.responsibleUnknown") }]),
    ...people.map((p) => ({ value: p.user_id, label: p.name })),
  ];
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label={t("agent.name")} htmlFor="agent-name" error={errors.fields.name}>
          <Input id="agent-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={disabled} maxLength={80} />
        </FormField>
        <FormField
          label={t("agent.handle")}
          htmlFor="agent-handle"
          hint={creating ? t("agent.handleHint", { handle: draft.handle || "handle" }) : t("agent.handleFixed")}
          error={errors.fields.handle}
        >
          <Input
            id="agent-handle"
            value={draft.handle}
            onChange={(e) => set({ handle: e.target.value.toLowerCase().replace(/^@/, "") })}
            disabled={disabled || !creating}
            autoCapitalize="none"
            spellCheck={false}
          />
        </FormField>
      </div>
      <FormField label={t("agent.description")} htmlFor="agent-desc" hint={t("agent.descriptionHint")} error={errors.fields.description}>
        <Textarea id="agent-desc" rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} disabled={disabled} />
      </FormField>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label={t("agent.role")} hint={t("agent.roleHint")} error={errors.fields.role}>
          <NativeSelect
            value={draft.role}
            onChange={(v) => set({ role: v as AgentDraft["role"] })}
            disabled={disabled}
            options={[
              { value: "member", label: t("role.member") },
              { value: "admin", label: t("role.admin") },
            ]}
          />
        </FormField>
        <FormField label={t("agent.responsibleField")} hint={t("agent.responsibleHint")} error={errors.fields.responsible}>
          <NativeSelect value={draft.responsible} onChange={(v) => set({ responsible: v })} disabled={disabled} options={responsibleChoices} />
        </FormField>
      </div>
    </div>
  );
}

export function AgentLimitFields({ draft, set, errors, disabled }: Props) {
  const projects = useProjects();
  const types = useChangeTypes();
  return (
    <div className="flex flex-col gap-4">
      <FormField label={t("agent.projects")} error={errors.fields.projects}>
        <MultiPick
          items={projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, keywords: p.key }))}
          value={draft.projects}
          onChange={(v) => set({ projects: v })}
          addLabel={t("agent.projectsPick")}
          empty={t("agent.projectsAll")}
          disabled={disabled}
        />
      </FormField>
      <SwitchRow title={t("agent.readOnly")} hint={t("agent.readOnlyHint")} checked={draft.readOnly} onChange={(v) => set({ readOnly: v })} disabled={disabled} />
      <FormField label={t("agent.approval")} hint={t("agent.approvalHint")} error={errors.fields.needs_approval}>
        <MultiPick
          items={types.map((type) => ({ id: type, label: type }))}
          value={draft.approval}
          onChange={(v) => set({ approval: v })}
          addLabel={t("agent.approvalPick")}
          empty={t("agent.approvalNone")}
          disabled={disabled}
        />
      </FormField>
      <div>
        <p className="text-xs font-medium text-ink-2">{t("agent.budget")}</p>
        <p className="mb-2 text-xs text-ink-3">{t("agent.budgetLead")}</p>
        <div className="grid max-w-md grid-cols-2 gap-3.5">
          <FormField label={t("agent.budgetMoney")} htmlFor="agent-money" error={errors.fields.cost_micros}>
            <span className="relative">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-3">$</span>
              <Input id="agent-money" inputMode="decimal" className="pl-6 tnum" value={draft.money} onChange={(e) => set({ money: e.target.value })} disabled={disabled} placeholder="—" />
            </span>
          </FormField>
          <FormField label={t("agent.budgetMinutes")} htmlFor="agent-minutes" error={errors.fields.minutes}>
            <Input id="agent-minutes" inputMode="numeric" className="tnum" value={draft.minutes} onChange={(e) => set({ minutes: e.target.value })} disabled={disabled} placeholder="—" />
          </FormField>
        </div>
      </div>
    </div>
  );
}

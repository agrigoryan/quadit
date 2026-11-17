// The fields of an agent, shared by "New agent" and the agent's own page.

import { t } from "@/lib/i18n";
import { useMembers, useProjects, useRowEvenIfGone } from "@/data/selectors";
import { ASKS_FIRST, AsksBefore } from "@/settings/agents/asks-before";
import { type AgentMember, toLimit } from "@/settings/agents/data";
import { AvatarInput } from "@/settings/ui/avatar-input";
import { MultiPick } from "@/settings/ui/multi-pick";
import { type FieldErrors, FormField, NativeSelect, SwitchRow } from "@/ui/form";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Input, Textarea } from "@/ui/input";

export interface AgentDraft {
  name: string;
  handle: string;
  description: string;
  /** A picture's address, an emoji or a letter or two; "" for initials. */
  avatar: string;
  role: "member" | "admin";
  /** A person's user id, or "" for "leave as it is". */
  responsible: string;
  projects: string[];
  readOnly: boolean;
  approval: string[];
  /** How many times a week it may pass work on to another agent, as typed; "" for no limit. */
  handoffLimit: string;
}

export const AGENT_FIELDS = [
  "name",
  "handle",
  "description",
  "avatar",
  "role",
  "responsible",
  "projects",
  "needs_approval",
  "handoff_limit",
];

export function draftOf(agent: AgentMember | undefined, responsible: string): AgentDraft {
  return {
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    description: agent?.title ?? "",
    avatar: agent?.avatar ?? "",
    role: agent?.role === "admin" ? "admin" : "member",
    responsible,
    projects: agent?.scope?.projects ?? [],
    readOnly: agent?.scope?.read_only ?? false,
    // A new agent asks before what cannot be taken back or reaches outside, unless its maker unticks it.
    approval: agent ? (agent.scope?.needs_approval ?? []) : ASKS_FIRST,
    handoffLimit: agent?.handoff_limit ? String(agent.handoff_limit) : "",
  };
}

/**
 * The scope and hand-off limit arguments for agent.create / agent.update,
 * or the field that is wrong. For a new agent the scope is always given, so
 * that the list of what it asks before is exactly the one shown (the server
 * fills in its own list when none is sent). A hand-off limit of null is
 * none.
 */
export function limitsOf(
  d: AgentDraft,
  creating = false,
): { scope: object | null; handoffLimit: number | null } | { bad: "handoff_limit" } {
  const handoffs = toLimit(d.handoffLimit);
  if (handoffs === null) return { bad: "handoff_limit" };
  const scoped = creating || d.projects.length > 0 || d.readOnly || d.approval.length > 0;
  return {
    scope: scoped ? { projects: d.projects, read_only: d.readOnly, needs_approval: d.approval } : null,
    handoffLimit: handoffs > 0 ? handoffs : null,
  };
}

interface Props {
  draft: AgentDraft;
  set: (patch: Partial<AgentDraft>) => void;
  errors: FieldErrors;
  /** The handle can be chosen only when the agent is made. */
  creating?: boolean;
  disabled?: boolean;
  /** The agent's user id (its own, or the one it will get): its initials are tinted by it. */
  seed?: string;
}

export function AgentProfileFields({ draft, set, errors, creating, disabled, seed }: Props) {
  const people = useMembers().filter((m) => m.kind === "person" && !m.suspended_at);
  // The one responsible now may no longer be among those who can be chosen (suspended, say): still name them.
  const current = useRowEvenIfGone("members", draft.responsible || undefined);
  const listed = people.some((p) => p.user_id === draft.responsible);
  const responsibleChoices = [
    ...(listed
      ? []
      : [
          current
            ? { value: current.user_id, label: current.name }
            : { value: "", label: creating ? t("common.you") : t("agent.responsibleNone") },
        ]),
    ...people.map((p) => ({ value: p.user_id, label: p.name })),
  ];
  return (
    <div className="flex flex-col gap-3.5">
      <FormField label={t("agent.avatar")} error={errors.fields.avatar}>
        <AvatarInput
          member={{ user_id: seed ?? draft.handle, name: draft.name.trim() || "?", kind: "agent" }}
          value={draft.avatar}
          onChange={(avatar) => set({ avatar })}
          hint={t("agent.avatarHint")}
          disabled={disabled}
        />
      </FormField>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label={t("agent.name")} htmlFor="agent-name" error={errors.fields.name}>
          <Input
            id="agent-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            disabled={disabled}
            maxLength={80}
          />
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
      <FormField
        label={t("agent.description")}
        htmlFor="agent-desc"
        hint={t("agent.descriptionHint")}
        error={errors.fields.description}
      >
        <Textarea
          id="agent-desc"
          rows={2}
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          disabled={disabled}
        />
      </FormField>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label={t("agent.role")} htmlFor="agent-role" hint={t("agent.roleHint")} error={errors.fields.role}>
          <NativeSelect
            id="agent-role"
            value={draft.role}
            onChange={(v) => set({ role: v as AgentDraft["role"] })}
            disabled={disabled}
            options={[
              { value: "member", label: t("role.member") },
              { value: "admin", label: t("role.admin") },
            ]}
          />
        </FormField>
        <FormField
          label={t("agent.responsibleField")}
          htmlFor="agent-responsible"
          hint={t("agent.responsibleHint")}
          error={errors.fields.responsible}
        >
          <NativeSelect
            id="agent-responsible"
            value={draft.responsible}
            onChange={(v) => set({ responsible: v })}
            disabled={disabled}
            options={responsibleChoices}
          />
        </FormField>
      </div>
    </div>
  );
}

export function AgentLimitFields({ draft, set, errors, disabled }: Props) {
  const projects = useProjects();
  return (
    <div className="flex flex-col gap-4">
      <FormField label={t("agent.projects")} error={errors.fields.projects}>
        <MultiPick
          items={projects.map((p) => ({
            id: p.id,
            label: p.name,
            icon: <ProjectGlyph project={p} />,
            keywords: p.key,
          }))}
          value={draft.projects}
          onChange={(v) => set({ projects: v })}
          addLabel={t("agent.projectsPick")}
          empty={t("agent.projectsAll")}
          disabled={disabled}
        />
      </FormField>
      <SwitchRow
        title={t("agent.readOnly")}
        hint={t("agent.readOnlyHint")}
        checked={draft.readOnly}
        onChange={(v) => set({ readOnly: v })}
        disabled={disabled}
      />
      <FormField label={t("agent.approval")} hint={t("agent.approvalHint")} error={errors.fields.needs_approval}>
        <AsksBefore value={draft.approval} onChange={(v) => set({ approval: v })} disabled={disabled} />
      </FormField>
      <FormField
        label={t("agent.handoffLimit")}
        hint={t("agent.handoffLimitHint")}
        htmlFor="agent-handoffs"
        error={errors.fields.handoff_limit}
      >
        <Input
          id="agent-handoffs"
          inputMode="numeric"
          className="max-w-32 tnum"
          value={draft.handoffLimit}
          onChange={(e) => set({ handoffLimit: e.target.value })}
          disabled={disabled}
          placeholder={t("agent.handoffLimitNone")}
        />
      </FormField>
    </div>
  );
}

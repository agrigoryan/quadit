// Limiting a person to some projects, or to reading. (An agent's limits are
// on its own page.) Saved as member.update {scope: {projects, read_only}};
// null lifts the limit. An owner always sees the whole workspace.

import { t } from "@/lib/i18n";
import { useProjects } from "@/lib/selectors";
import type { Member } from "@/lib/types";
import type { ScopedMember } from "@/settings/agents/data";
import { FormField, SwitchRow } from "@/settings/ui/form";
import { MultiPick } from "@/settings/ui/multi-pick";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Badge } from "@/ui/badge";

export interface ScopeDraft {
  /** Project ids; none means every project. */
  projects: string[];
  readOnly: boolean;
}

export const scopeDraftOf = (m: Member | undefined): ScopeDraft => {
  const scope = (m as ScopedMember | undefined)?.scope;
  return { projects: scope?.projects ?? [], readOnly: scope?.read_only ?? false };
};

/** The `scope` argument: the limit, or null for none. */
export const scopeArg = (d: ScopeDraft) => (d.projects.length > 0 || d.readOnly ? { projects: d.projects, read_only: d.readOnly } : null);

export const sameScope = (a: ScopeDraft, b: ScopeDraft) =>
  a.readOnly === b.readOnly && a.projects.length === b.projects.length && a.projects.every((p) => b.projects.includes(p));

interface Props {
  value: ScopeDraft;
  onChange: (next: ScopeDraft) => void;
  error?: string;
}

export function MemberScopeFields({ value, onChange, error }: Props) {
  const projects = useProjects();
  return (
    <>
      <FormField label={t("members.projects")} hint={t("members.projectsHint")} error={error}>
        <MultiPick
          items={projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, keywords: p.key }))}
          value={value.projects}
          onChange={(next) => onChange({ ...value, projects: next })}
          addLabel={t("agent.projectsPick")}
          empty={t("s.everyProject")}
        />
      </FormField>
      <SwitchRow title={t("members.readOnly")} hint={t("members.readOnlyHint")} checked={value.readOnly} onChange={(readOnly) => onChange({ ...value, readOnly })} />
    </>
  );
}

/** "2 projects" and "Read-only", for a member whose access is limited. */
export function ScopeTags({ member }: { member: Member }) {
  const scope = (member as ScopedMember).scope;
  const n = scope?.projects?.length ?? 0;
  if (n === 0 && !scope?.read_only) return null;
  return (
    <>
      {n > 0 && <Badge>{t("members.projectsN", { n })}</Badge>}
      {scope?.read_only && <Badge>{t("members.readOnlyTag")}</Badge>}
    </>
  );
}

// The project a new task goes into, at the top left of the create dialog.

import { t } from "@/lib/i18n";
import { useProjects } from "@/lib/selectors";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Select } from "@/ui/picker";

export function ProjectSelect({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const projects = useProjects();
  return (
    <Select
      label={t("prop.project")}
      value={value}
      items={projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, hint: p.key }))}
      onPick={onPick}
      buttonProps={{ size: "sm" }}
    />
  );
}

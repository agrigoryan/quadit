// What a task template fills in when it is picked in the create dialog: its
// status, priority, labels and assignee, which the template stores by name.

import { getState } from "@/lib/store";
import type { Project, Template } from "@/lib/types";
import type { TaskFields } from "@/tasks/create-fields";

/** What a template fills in, looked up by the names it stores. */
export function presetOf(template: Template | undefined, project: Project): Partial<TaskFields> {
  const preset = template?.preset;
  if (!preset) return {};
  const { collections: c } = getState();
  const low = (s: string) => s.toLowerCase();
  const out: Partial<TaskFields> = {};
  if (preset.priority) out.priority = preset.priority;
  if (preset.status) {
    const status = Object.values(c.statuses).find(
      (s) => s.project_id === project.id && low(s.name) === low(preset.status as string),
    );
    if (status) out.statusId = status.id;
  }
  if (preset.labels?.length) {
    const names = preset.labels.map(low);
    out.labelIds = Object.values(c.labels)
      .filter(
        (l) =>
          !l.deleted_at &&
          (!l.project_id || l.project_id === project.id) &&
          (names.includes(low(l.name)) || names.includes(l.id)),
      )
      .map((l) => l.id);
  }
  if (preset.assignee) {
    const handle = low(preset.assignee.replace(/^@/, ""));
    const member = Object.values(c.members).find((m) => low(m.handle) === handle || m.user_id === preset.assignee);
    if (member) out.assigneeId = member.user_id;
  }
  return out;
}

// What a task template fills in when it is picked in the create dialog: its
// status, priority, labels and assignee, which the template stores by name.

import { getRows } from "@/lib/selectors";
import type { Project, Template } from "@/lib/types";
import type { TaskFields } from "@/tasks/properties/property";

/** What a template fills in, looked up by the names it stores. */
export function presetOf(template: Template | undefined, project: Project): Partial<TaskFields> {
  const preset = template?.preset;
  if (!preset) return {};
  const low = (s: string) => s.toLowerCase();
  const out: Partial<TaskFields> = {};
  if (preset.priority) out.priority = preset.priority;
  if (preset.status) {
    const status = getRows("statuses").find(
      (s) => s.project_id === project.id && low(s.name) === low(preset.status as string),
    );
    if (status) out.statusId = status.id;
  }
  if (preset.labels?.length) {
    const names = preset.labels.map(low);
    out.labelIds = getRows("labels")
      .filter(
        (l) => (!l.project_id || l.project_id === project.id) && (names.includes(low(l.name)) || names.includes(l.id)),
      )
      .map((l) => l.id);
  }
  if (preset.assignee) {
    const handle = low(preset.assignee.replace(/^@/, ""));
    const member = getRows("members").find((m) => low(m.handle) === handle || m.user_id === preset.assignee);
    if (member) out.assigneeId = member.user_id;
  }
  return out;
}

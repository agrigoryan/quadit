// What a task template fills in when it is picked in the create dialog: its
// status, priority, labels and assignee, which the template stores by name
// (its status may be a status type, as the server takes it). As on the
// server, it fills only what the person left empty.
// Its estimate is not filled in: the server applies it as it is stored, and
// the create dialog's pill shows it until the person picks another.

import { getRows } from "@/data/selectors";
import type { Project, Template } from "@/types/core";
import type { TaskFields } from "@/tasks/properties/property";

/** What a template fills in of the fields still empty, looked up by the names it stores. */
export function presetOf(template: Template | undefined, project: Project, fields: TaskFields): Partial<TaskFields> {
  const preset = template?.preset;
  if (!preset) return {};
  const low = (s: string) => s.toLowerCase();
  const out: Partial<TaskFields> = {};
  if (preset.priority && !fields.priority) out.priority = preset.priority;
  if (preset.status && !fields.statusId) {
    // As the server reads it: a status of the project by name, else the first of that type ("started").
    const word = low(preset.status.trim());
    const own = getRows("statuses")
      .filter((s) => s.project_id === project.id)
      .sort((a, b) => (a.rank < b.rank ? -1 : 1));
    const status = own.find((s) => low(s.name) === word) ?? own.find((s) => s.category === word);
    if (status) out.statusId = status.id;
  }
  if (preset.labels?.length && fields.labelIds.length === 0) {
    const names = preset.labels.map(low);
    out.labelIds = getRows("labels")
      .filter(
        (l) => (!l.project_id || l.project_id === project.id) && (names.includes(low(l.name)) || names.includes(l.id)),
      )
      .map((l) => l.id);
  }
  if (preset.assignee && !fields.assigneeId) {
    const handle = low(preset.assignee.replace(/^@/, ""));
    const member = getRows("members").find((m) => low(m.handle) === handle || m.user_id === preset.assignee);
    if (member) out.assigneeId = member.user_id;
  }
  return out;
}

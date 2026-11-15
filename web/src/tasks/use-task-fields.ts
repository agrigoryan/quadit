// The project of the task (or tasks) being created and the properties the
// row under the title sets. Changing the project drops what belonged to the
// old one.

import { useState } from "react";
import type { TaskFields } from "@/tasks/properties/property";
import { useCreatableProjects } from "@/tasks/data";
import type { NewTaskDraft } from "@/tasks/draft";

/** `shared`: for several tasks at once, which have no parent of their own. */
export function useTaskFields(draft: NewTaskDraft, { shared = false }: { shared?: boolean } = {}) {
  // Only a project the member may create in; none for one who is read-only.
  const projects = useCreatableProjects();
  const [projectId, setProjectId] = useState(draft.projectId ?? projects[0]?.id ?? "");
  const [fields, setFields] = useState<TaskFields>({
    statusId: draft.statusId ?? "",
    assigneeId: draft.assigneeId ?? "",
    priority: 0,
    labelIds: draft.labelIds ?? [],
    epicId: draft.epicId ?? "",
    parentId: shared ? "" : (draft.parentId ?? ""),
    dueOn: "",
    templateId: "",
  });

  const change = (patch: Partial<TaskFields>) => setFields((f) => ({ ...f, ...patch }));

  function changeProject(id: string) {
    setProjectId(id);
    // Status, labels, epic, parent and template belong to a project.
    change({ statusId: "", labelIds: [], epicId: "", parentId: "", templateId: "" });
  }

  return { projectId, project: projects.find((p) => p.id === projectId), fields, change, changeProject };
}

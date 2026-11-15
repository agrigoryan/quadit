// What the create dialog can be opened with. The shell's draft (lib/ui-state)
// carries a project, status, parent, epic, cycle and assignee; lists and the
// palette also hand over labels, and ask for the dialog that makes several
// tasks at once.

import { type TaskDraft, ui } from "@/lib/ui-state";

export type NewTaskDraft = TaskDraft & {
  labelIds?: string[];
  /** Open on "several tasks": one title per line. */
  many?: boolean;
};

/** Opens the create dialog. */
export const openNewTask = (draft: NewTaskDraft = {}) => ui.newTask(draft);

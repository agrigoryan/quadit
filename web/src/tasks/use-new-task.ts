// The one task being written in the create dialog: its title, description
// and properties, and what creating it does. The dialog closes (or, with
// "Create more", empties for the next task) at once; the task is sent behind
// it, and the toast that says it was made offers to open it.

import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import { ui } from "@/lib/ui-state";
import { useFieldErrors } from "@/ui/form";
import { createTask, type NewTask } from "@/tasks/actions";
import type { TaskFields } from "@/tasks/create-fields";
import type { NewTaskDraft } from "@/tasks/draft";
import { presetOf } from "@/tasks/template-preset";
import { useTaskFields } from "@/tasks/use-task-fields";

/** Sends the task; the toast that says it was made offers to open it. */
async function send(task: NewTask, open: (key: string) => void) {
  try {
    const key = await createTask(task);
    toast.info(t("create.created", { key }), { label: t("create.open"), run: () => open(key) });
  } catch (err) {
    // A refusal is shown as a toast by mutate; anything else is said here.
    if (!(err instanceof Error && err.name === "ApiError")) toast.error(errorMessage(err));
  }
}

export function useNewTask(draft: NewTaskDraft) {
  const slug = useSlug();
  const navigate = useNavigate();
  const location = useLocation();
  const props = useTaskFields(draft);
  const { project, fields } = props;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState(false);
  /** "Create more": the dialog stays for the next task. */
  const [more, setMore] = useState(false);
  // Both are checked here, before anything is sent, and shown in one place under the description.
  const errors = useFieldErrors(["project", "title"]);
  const titleBox = useRef<HTMLInputElement>(null);

  function change(patch: Partial<TaskFields>) {
    if (patch.templateId !== undefined && project) {
      // Picking a template fills what is still empty, so its effect is visible before creating.
      const template = getState().collections.templates[patch.templateId];
      if (template?.title && !title.trim()) setTitle(template.title);
      if (template?.description && !description.trim()) setDescription(template.description);
      patch = { ...presetOf(template, project), ...patch };
    }
    props.change(patch);
  }

  async function create() {
    errors.clear();
    if (!project) return errors.set("project", t("create.noProject"));
    if (!title.trim()) {
      errors.set("title", t("create.needTitle"));
      titleBox.current?.focus();
      return;
    }
    const task: NewTask = {
      projectId: project.id,
      title,
      description,
      ...fields,
      statusId: fields.statusId || undefined,
      assigneeId: fields.assigneeId || undefined,
      epicId: fields.epicId || undefined,
      parentId: fields.parentId || undefined,
      cycleId: draft.cycleId,
      dueOn: fields.dueOn || undefined,
      templateId: fields.templateId || undefined,
    };
    if (more) {
      setTitle("");
      setDescription("");
      setPreview(false);
      titleBox.current?.focus();
    } else ui.closeNewTask();
    await send(task, (key) => void navigate(`/${slug}/task/${key}`, { state: { background: location } }));
  }

  return {
    ...props,
    change,
    text: { title, setTitle, description, setDescription },
    preview,
    setPreview,
    more,
    setMore,
    error: errors.fields.project || errors.fields.title,
    titleBox,
    create,
  };
}

// The "new task" dialog (C): one task with its title, description and
// properties, or, on request, several at once (tasks/multi-create.tsx).

import { type FormEvent, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { sendOnModEnter } from "@/lib/mod-enter";
import { getState } from "@/lib/store";
import { useTaskNav } from "@/lib/task-link";
import { toast } from "@/lib/toast";
import { ui } from "@/lib/ui-state";
import { createTask } from "@/tasks/actions";
import { CreateFields, type TaskFields } from "@/tasks/create-fields";
import type { NewTaskDraft } from "@/tasks/draft";
import { MultiCreateDialog } from "@/tasks/multi-create";
import { ProjectSelect } from "@/tasks/project-select";
import { presetOf } from "@/tasks/template-preset";
import { useTaskFields } from "@/tasks/use-task-fields";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import { Markdown } from "@/ui/markdown";
import { MentionTextarea } from "@/ui/mention-textarea";

/** The "new task" dialog (C), for one task or, on request, for several at once. */
export function CreateTaskDialog({ draft }: { draft: NewTaskDraft }) {
  const [many, setMany] = useState(!!draft.many);
  return many ? (
    <MultiCreateDialog draft={draft} onSingle={() => setMany(false)} />
  ) : (
    <SingleDialog draft={draft} onMany={() => setMany(true)} />
  );
}

/** One task. Cmd/Ctrl-Enter creates; "Create more" keeps it open for the next one. */
function SingleDialog({ draft, onMany }: { draft: NewTaskDraft; onMany: () => void }) {
  const nav = useTaskNav();
  const titleBox = useRef<HTMLInputElement>(null);
  const { projectId, project, fields, change: changeFields, changeProject } = useTaskFields(draft);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState(false);
  /** "Create more": the dialog stays for the next task. */
  const [more, setMore] = useState(false);
  /** What is missing, found before anything is sent: the project or the title. */
  const [error, setError] = useState("");

  function change(patch: Partial<TaskFields>) {
    if (patch.templateId !== undefined && project) {
      // Picking a template fills what is still empty, so its effect is visible before creating.
      const template = getState().collections.templates[patch.templateId];
      if (template?.title && !title.trim()) setTitle(template.title);
      if (template?.description && !description.trim()) setDescription(template.description);
      patch = { ...presetOf(template, project), ...patch };
    }
    changeFields(patch);
  }

  /**
   * The dialog closes, or empties for the next task, before the task is sent;
   * the toast that says it was made offers to open it.
   */
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!project) return setError(t("create.noProject"));
    if (!title.trim()) {
      setError(t("create.needTitle"));
      titleBox.current?.focus();
      return;
    }
    setError("");
    const task = {
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
    try {
      const key = await createTask(task);
      toast.info(t("create.created", { key }), {
        label: t("create.open"),
        run: () => nav.peek(key),
      });
    } catch (err) {
      // A refusal is shown as a toast by mutate; anything else is said here.
      if (!(err instanceof Error && err.name === "ApiError")) toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && ui.closeNewTask()}
      title={t("create.title")}
      hideTitle
      size="md"
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-ink-2 select-none">
            <input
              type="checkbox"
              checked={more}
              onChange={(e) => setMore(e.target.checked)}
              className="size-3.5 accent-(--accent)"
            />
            {t("create.more")}
          </label>
          <Button variant="ghost" onClick={ui.closeNewTask}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} className="max-sm:h-10 max-sm:px-4">
            {t("create.submit")}
            <span className="max-sm:hidden">
              <Kbd onDark>{`${MOD} ↵`}</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <form onSubmit={submit} onKeyDown={(e) => sendOnModEnter(e, submit)} className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <ProjectSelect value={projectId} onPick={changeProject} />
          <span className="text-xs text-ink-3 max-sm:hidden">{t("create.title")}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onMany} aria-label={t("multi.open")}>
            <span className="max-sm:hidden">{t("multi.open")}</span>
            <span className="sm:hidden">{t("multi.openShort")}</span>
          </Button>
          <div className="flex rounded-md bg-sunken p-0.5 text-xs">
            {[false, true].map((p) => (
              <button
                key={String(p)}
                type="button"
                aria-pressed={preview === p}
                onClick={() => setPreview(p)}
                className={`h-5 rounded-sm px-2 font-medium ${preview === p ? "bg-surface text-ink shadow-card" : "text-ink-2"}`}
              >
                {p ? t("create.preview") : t("create.write")}
              </button>
            ))}
          </div>
        </div>
        <input
          ref={titleBox}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("create.titlePlaceholder")}
          aria-label={t("create.titlePlaceholder")}
          aria-invalid={!!error}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none"
        />
        <div className="min-h-24">
          {preview ? (
            description.trim() ? (
              <Markdown text={description} />
            ) : (
              <p className="text-sm text-ink-3">{t("create.descPlaceholder")}</p>
            )
          ) : (
            <MentionTextarea
              bare
              value={description}
              onChange={setDescription}
              placeholder={t("create.descPlaceholder")}
              aria-label={t("create.descPlaceholder")}
              className="min-h-24 text-sm leading-6"
            />
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {project && <CreateFields project={project} value={fields} onChange={change} onLeave={ui.closeNewTask} />}
      </form>
    </Dialog>
  );
}

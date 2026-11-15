import { type FormEvent, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { errorMessage } from "@/lib/api";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useProjects, useSlug } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Project, Template } from "@/lib/types";
import { ui } from "@/lib/ui-state";
import { ProjectGlyph } from "@/ui/project-glyph";
import { createTask } from "@/tasks/actions";
import { CreateFields, type TaskFields } from "@/tasks/create-fields";
import type { NewTaskDraft } from "@/tasks/draft";
import { MultiCreateDialog } from "@/tasks/multi-create";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import { Markdown } from "@/ui/markdown";
import { MentionTextarea } from "@/ui/mention-textarea";
import { Select } from "@/ui/picker";

/** What a template fills in, looked up by the names it stores. */
function presetOf(template: Template | undefined, project: Project): Partial<TaskFields> {
  const preset = template?.preset;
  if (!preset) return {};
  const { c } = getState();
  const low = (s: string) => s.toLowerCase();
  const out: Partial<TaskFields> = {};
  if (preset.priority) out.priority = preset.priority;
  if (preset.status) {
    const status = Object.values(c.statuses).find((s) => s.project_id === project.id && low(s.name) === low(preset.status as string));
    if (status) out.statusId = status.id;
  }
  if (preset.labels?.length) {
    const names = preset.labels.map(low);
    out.labelIds = Object.values(c.labels)
      .filter((l) => !l.deleted_at && (!l.project_id || l.project_id === project.id) && (names.includes(low(l.name)) || names.includes(l.id)))
      .map((l) => l.id);
  }
  if (preset.assignee) {
    const handle = low(preset.assignee.replace(/^@/, ""));
    const member = Object.values(c.members).find((m) => low(m.handle) === handle || m.user_id === preset.assignee);
    if (member) out.assigneeId = member.user_id;
  }
  return out;
}

/** The "new task" dialog (C), for one task or, on request, for several at once. */
export function CreateTaskDialog({ draft }: { draft: NewTaskDraft }) {
  const [many, setMany] = useState(!!draft.many);
  return many ? <MultiCreateDialog draft={draft} onSingle={() => setMany(false)} /> : <SingleDialog draft={draft} onMany={() => setMany(true)} />;
}

/** One task. Cmd/Ctrl-Enter creates; "Create more" keeps it open for the next one. */
function SingleDialog({ draft, onMany }: { draft: NewTaskDraft; onMany: () => void }) {
  const slug = useSlug();
  const projects = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const titleBox = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState(draft.projectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<TaskFields>({
    statusId: draft.statusId ?? "",
    assigneeId: draft.assigneeId ?? "",
    priority: 0,
    labelIds: draft.labelIds ?? [],
    epicId: draft.epicId ?? "",
    parentId: draft.parentId ?? "",
    dueOn: "",
    templateId: "",
  });
  const project = projects.find((p) => p.id === projectId);

  function change(patch: Partial<TaskFields>) {
    if (patch.templateId !== undefined && project) {
      // Picking a template fills what is still empty, so its effect is visible before creating.
      const template = getState().c.templates[patch.templateId];
      if (template?.title && !title.trim()) setTitle(template.title);
      if (template?.description && !description.trim()) setDescription(template.description);
      patch = { ...presetOf(template, project), ...patch };
    }
    setFields((f) => ({ ...f, ...patch }));
  }

  function changeProject(id: string) {
    setProjectId(id);
    // Status, labels, epic, parent and template belong to a project.
    setFields((f) => ({ ...f, statusId: "", labelIds: [], epicId: "", parentId: "", templateId: "" }));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!project) return setError(t("create.noProject"));
    if (!title.trim()) {
      setError(t("create.needTitle"));
      titleBox.current?.focus();
      return;
    }
    setError("");
    const input = { projectId: project.id, title, description, ...fields };
    if (more) {
      setTitle("");
      setDescription("");
      setPreview(false);
      titleBox.current?.focus();
    } else ui.closeNewTask();
    try {
      const key = await createTask({
        ...input,
        statusId: input.statusId || undefined,
        assigneeId: input.assigneeId || undefined,
        epicId: input.epicId || undefined,
        parentId: input.parentId || undefined,
        cycleId: draft.cycleId,
        dueOn: input.dueOn || undefined,
        templateId: input.templateId || undefined,
      });
      toast.info(t("create.created", { key }), {
        label: t("create.open"),
        run: () => navigate(`/${slug}/task/${key}`, { state: { background: location } }),
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
            <input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} className="size-3.5 accent-(--accent)" />
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
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
        className="flex flex-col gap-2.5"
      >
        <div className="flex items-center gap-2">
          <Select
            label={t("prop.project")}
            value={projectId}
            items={projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph project={p} />, hint: p.key }))}
            onPick={changeProject}
            buttonProps={{ size: "sm" }}
          />
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

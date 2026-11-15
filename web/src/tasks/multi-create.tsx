// Several tasks at once: one title per line (a pasted list works), with the
// project, status, assignee, labels and the rest shared by all of them. They
// are sent as one batch, so either all of them are made or none.

import { useMemo, useState } from "react";
import { errorMessage } from "@/lib/api";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useProjects } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { ui } from "@/lib/ui-state";
import { ProjectGlyph } from "@/ui/project-glyph";
import { createTasks } from "@/tasks/actions";
import { CreateFields, type TaskFields } from "@/tasks/create-fields";
import type { NewTaskDraft } from "@/tasks/draft";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Textarea } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { Select } from "@/ui/picker";

/** A pasted list often brings its bullets, numbers and check boxes along; a title does not need them. */
const MARKER = /^\s*(?:[-*+•–]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s+)?/;

/** The titles in the text: one per line, list markers and blank lines dropped. */
function titlesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(MARKER, "").trim())
    .filter(Boolean);
}

interface Props {
  draft: NewTaskDraft;
  /** Back to the dialog for one task. */
  onSingle: () => void;
}

export function MultiCreateDialog({ draft, onSingle }: Props) {
  const projects = useProjects();
  const [projectId, setProjectId] = useState(draft.projectId ?? projects[0]?.id ?? "");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<TaskFields>({
    statusId: draft.statusId ?? "",
    assigneeId: draft.assigneeId ?? "",
    priority: 0,
    labelIds: draft.labelIds ?? [],
    epicId: draft.epicId ?? "",
    parentId: "",
    dueOn: "",
    templateId: "",
  });
  const project = projects.find((p) => p.id === projectId);
  const titles = useMemo(() => titlesOf(text), [text]);

  function changeProject(id: string) {
    setProjectId(id);
    // Status, labels and epic belong to a project.
    setFields((f) => ({ ...f, statusId: "", labelIds: [], epicId: "" }));
  }

  async function submit() {
    if (busy) return;
    if (!project) return setError(t("create.noProject"));
    if (titles.length === 0) return setError(t("multi.needTitles"));
    setError("");
    setBusy(true);
    try {
      const n = await createTasks(
        {
          projectId: project.id,
          statusId: fields.statusId || undefined,
          assigneeId: fields.assigneeId || undefined,
          priority: fields.priority || undefined,
          labelIds: fields.labelIds,
          epicId: fields.epicId || undefined,
          cycleId: draft.cycleId,
          dueOn: fields.dueOn || undefined,
        },
        titles,
      );
      ui.closeNewTask();
      toast.info(t("multi.created", { n, project: project.name }));
    } catch (err) {
      // The dialog stays open with the list as typed, and says why nothing was made.
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && ui.closeNewTask()}
      title={t("multi.title")}
      hideTitle
      size="md"
      footer={
        <>
          <span className="mr-auto text-xs text-ink-2 tnum" aria-live="polite">
            {t("multi.count", { n: titles.length })}
          </span>
          <Button variant="ghost" onClick={ui.closeNewTask}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || titles.length === 0}
            onClick={() => void submit()}
            className="max-sm:h-10 max-sm:px-4"
          >
            {t("multi.submit", { n: titles.length })}
            <span className="max-sm:hidden">
              <Kbd onDark>{`${MOD} ↵`}</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
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
          <span className="text-xs text-ink-3">{t("multi.title")}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onSingle}>
            {t("multi.single")}
          </Button>
        </div>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("multi.placeholder")}
          aria-label={t("multi.label")}
          aria-invalid={!!error}
          aria-describedby="multi-hint"
          rows={8}
          className="min-h-40 font-medium leading-6"
        />
        <p id="multi-hint" className="text-xs text-ink-3">
          {t("multi.hint")}
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {project && (
          <CreateFields
            project={project}
            value={fields}
            onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
            shared
            onLeave={ui.closeNewTask}
          />
        )}
      </form>
    </Dialog>
  );
}

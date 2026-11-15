// Several tasks at once: one title per line (a pasted list works), with the
// project, status, assignee, labels and the rest shared by all of them. They
// are sent as one batch, so either all of them are made or none.

import { useMemo, useState } from "react";
import { useCan } from "@/data/access";
import { errorMessage } from "@/data/api";
import { MOD } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { sendOnModEnter } from "@/lib/mod-enter";
import { toast } from "@/lib/toast";
import { ui } from "@/lib/ui-state";
import { createTasks } from "@/tasks/actions";
import { CreateFields } from "@/tasks/create-fields";
import type { NewTaskDraft } from "@/tasks/draft";
import { ProjectSelect } from "@/tasks/project-select";
import { useTaskFields } from "@/tasks/use-task-fields";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Textarea } from "@/ui/input";
import { Kbd } from "@/ui/kbd";

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
  const { projectId, project, fields, change, changeProject } = useTaskFields(draft, { shared: true });
  const [text, setText] = useState("");
  /** What is missing, or why the server made none of them: one line under the list. Editing the list or the project drops it. */
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Opened by someone who may change nothing, the dialog offers nothing to create.
  const readOnly = !useCan().write;
  const titles = useMemo(() => titlesOf(text), [text]);

  async function submit() {
    if (busy || readOnly) return;
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
            disabled={busy || readOnly || titles.length === 0}
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
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keys typed in the form's fields bubble up to here; the form itself is not a control */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => sendOnModEnter(e, submit)}
        className="flex flex-col gap-2.5"
      >
        <div className="flex items-center gap-2">
          <ProjectSelect
            value={projectId}
            onPick={(id) => {
              changeProject(id);
              setError("");
            }}
          />
          <span className="text-xs text-ink-3">{t("multi.title")}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onSingle}>
            {t("multi.single")}
          </Button>
        </div>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
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
          <CreateFields project={project} value={fields} onChange={change} shared onLeave={ui.closeNewTask} />
        )}
      </form>
    </Dialog>
  );
}

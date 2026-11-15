// "Ask a question" on a task: the question, its details, a choice between
// options (each with media) or a plain approval, the asker's recommendation
// and who should answer. Checked here before it is sent.

import { useId, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { sendOnModEnter } from "@/lib/mod-enter";
import { useMe, useMembers, useTask } from "@/lib/selectors";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormField } from "@/ui/form";
import { Input } from "@/ui/input";
import { MentionTextarea } from "@/ui/mention-textarea";
import { type NewDecision, type NewOptionFile, openDecision } from "@/decisions/actions";
import { useReturnFocus } from "@/decisions/data";
import { type AnswerKind, HowToAnswer } from "@/decisions/how-to-answer";
import { blankOption, NewDecisionOptions } from "@/decisions/new-decision-options";
import type { DraftOption } from "@/decisions/option-editor";

/** What stops the question from being sent, found when the asker tries to. */
interface Problems {
  question?: string;
  options?: string;
  /** Options that have content but no label. */
  unlabelled: string[];
}

interface Composed {
  question: string;
  details: string;
  kind: AnswerKind;
  options: DraftOption[];
  /** The id of the option the asker recommends. */
  recommended: string | null;
  /** Why that one. */
  reason: string;
  /** Who should answer; null for anyone. */
  ask: string | null;
  problems: Problems;
}

const hasContent = (o: DraftOption) => !!o.label.trim() || !!o.description.trim() || o.files.length > 0;
const labelled = (options: DraftOption[]) => options.filter((o) => o.label.trim()).length;

/** What is wrong with the question, and the question as it would be sent when nothing is. */
function examine(taskId: string, draft: Composed): { problems: Problems; decision: NewDecision | null } {
  const { question, details, kind, options, recommended, reason, ask } = draft;
  const kept = kind === "choice" ? options.filter(hasContent) : [];
  const problems: Problems = { unlabelled: kept.filter((o) => !o.label.trim()).map((o) => o.id) };
  if (!question.trim()) problems.question = t("decision.new.needQuestion");
  if (kind === "choice" && labelled(kept) < 2) problems.options = t("decision.new.needOptions");
  if (problems.question || problems.options || problems.unlabelled.length > 0) return { problems, decision: null };
  const decision: NewDecision = {
    taskId,
    kind,
    question,
    details,
    options: kept.map((o) => ({
      ...o,
      files: o.files.flatMap((f): NewOptionFile[] => (f.file ? [{ file: f.file, role: f.role }] : [])),
    })),
    recommended: kept.some((o) => o.id === recommended) ? (recommended ?? undefined) : undefined,
    recommendation: reason,
    ask: ask ?? undefined,
  };
  return { problems, decision };
}

/** Mount it only while it is open, so each question starts empty. */
export function NewDecisionDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const me = useMe();
  const task = useTask(taskId);
  const [draft, setDraft] = useState<Composed>(() => ({
    question: "",
    details: "",
    kind: "choice",
    options: [blankOption(), blankOption()],
    recommended: null,
    reason: "",
    // Whoever works on the task is the likely one to ask.
    ask: task?.assignee_id && task.assignee_id !== me.user_id ? task.assignee_id : null,
    problems: { unlabelled: [] },
  }));
  const set = (fields: Partial<Composed>) => setDraft((d) => ({ ...d, ...fields }));
  const { problems } = draft;
  // A message stays only while what it points at is still wrong.
  const questionError = !draft.question.trim() ? problems.question : undefined;
  const optionsError = labelled(draft.options) < 2 ? problems.options : undefined;
  const uploading = draft.kind === "choice" && draft.options.some((o) => o.files.some((f) => !f.file && !f.failed));
  // The people who can be asked: everyone but the asker and the suspended.
  const askable = useMembers().filter((m) => m.user_id !== me.user_id && !m.suspended_at);
  const asked = askable.find((m) => m.user_id === draft.ask);
  /** The server's refusal: one line in the footer, whichever field it names. */
  const [refusal, setRefusal] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = { question: useId(), details: useId() };
  const form = useRef<HTMLDivElement | null>(null);
  useReturnFocus();

  async function submit() {
    if (busy || uploading) return;
    setRefusal("");
    const { problems, decision } = examine(taskId, draft);
    set({ problems });
    if (!decision) {
      // Bring the first thing to fix into view once it is drawn.
      requestAnimationFrame(() => form.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "center" }));
      return;
    }
    setBusy(true);
    try {
      await openDecision(decision);
      onClose();
    } catch (err) {
      setRefusal(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("decision.new.title")}
      description={task ? t("decision.new.onTask", { key: task.key, title: task.title }) : undefined}
      size="lg"
      footer={
        <>
          {refusal && (
            <p role="alert" className="mr-auto min-w-0 text-xs text-danger">
              {refusal}
            </p>
          )}
          <Button variant="ghost" className="max-sm:h-10" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            className="max-sm:h-10 max-sm:flex-1"
            disabled={busy || uploading}
            onClick={() => void submit()}
          >
            {uploading
              ? t("decision.new.waitUploads")
              : asked
                ? t("decision.new.submitTo", { name: asked.name })
                : t("decision.new.submit")}
          </Button>
        </>
      }
    >
      <div ref={form} className="flex flex-col gap-4" onKeyDown={(e) => sendOnModEnter(e, submit)}>
        <FormField label={t("decision.new.question")} htmlFor={ids.question} error={questionError}>
          <Input
            id={ids.question}
            autoFocus
            value={draft.question}
            onChange={(e) => set({ question: e.target.value })}
            placeholder={t("decision.new.questionPlaceholder")}
            className={cx("h-9! text-base! font-medium max-sm:h-10!", questionError && "border-danger!")}
          />
        </FormField>

        <FormField
          label={t("decision.new.details")}
          htmlFor={ids.details}
          hint={t("decision.new.detailsHint", { mod: MOD })}
        >
          <MentionTextarea
            id={ids.details}
            value={draft.details}
            onChange={(details) => set({ details })}
            rows={2}
            placeholder={t("decision.new.detailsPlaceholder")}
            className="min-h-14 max-sm:text-base"
          />
        </FormField>

        <HowToAnswer
          kind={draft.kind}
          onKind={(kind) => set({ kind })}
          ask={draft.ask}
          onAsk={(ask) => set({ ask })}
          people={askable}
        />

        {draft.kind === "choice" ? (
          <NewDecisionOptions
            options={draft.options}
            onChange={(change) => setDraft((d) => ({ ...d, options: change(d.options) }))}
            recommended={draft.recommended}
            onRecommend={(recommended) => set({ recommended })}
            reason={draft.reason}
            onReason={(reason) => set({ reason })}
            error={optionsError}
            unlabelled={problems.unlabelled}
          />
        ) : (
          <p className="text-sm text-ink-2">{t("decision.new.approvalHint")}</p>
        )}
      </div>
    </Dialog>
  );
}

// "Ask a question" on a task: the question, its details, a choice between
// options (each with media) or a plain approval, the asker's recommendation
// and who should answer. Checked here before it is sent.

import { useId, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { useMe, useMembers, useTask } from "@/lib/selectors";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Field, Input } from "@/ui/input";
import { MentionTextarea } from "@/ui/mention-textarea";
import { openDecision } from "@/decisions/actions";
import { useReturnFocus } from "@/decisions/data";
import { HowToAnswer } from "@/decisions/how-to-answer";
import { sendOnModEnter } from "@/lib/mod-enter";
import { NewDecisionOptions } from "@/decisions/new-decision-options";
import { useNewDecision } from "@/decisions/use-new-decision";

/** Mount it only while it is open, so each question starts empty. */
export function NewDecisionDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const me = useMe();
  const task = useTask(taskId);
  const compose = useNewDecision(taskId);
  const { draft, actions, questionError, uploading } = compose;
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
    const decision = actions.check();
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
        <Field label={t("decision.new.question")} htmlFor={ids.question}>
          <Input
            id={ids.question}
            autoFocus
            value={draft.question}
            onChange={(e) => actions.setQuestion(e.target.value)}
            placeholder={t("decision.new.questionPlaceholder")}
            aria-invalid={!!questionError}
            className={cx("h-9! text-base! font-medium max-sm:h-10!", questionError && "border-danger!")}
          />
          {questionError && (
            <p role="alert" className="text-xs text-danger">
              {questionError}
            </p>
          )}
        </Field>

        <Field
          label={t("decision.new.details")}
          htmlFor={ids.details}
          hint={t("decision.new.detailsHint", { mod: MOD })}
        >
          <MentionTextarea
            id={ids.details}
            value={draft.details}
            onChange={actions.setDetails}
            rows={2}
            placeholder={t("decision.new.detailsPlaceholder")}
            className="min-h-14 max-sm:text-base"
          />
        </Field>

        <HowToAnswer
          kind={draft.kind}
          onKind={actions.setKind}
          ask={draft.ask}
          onAsk={actions.setAsk}
          people={askable}
        />

        {draft.kind === "choice" ? (
          <NewDecisionOptions compose={compose} />
        ) : (
          <p className="text-sm text-ink-2">{t("decision.new.approvalHint")}</p>
        )}
      </div>
    </Dialog>
  );
}
